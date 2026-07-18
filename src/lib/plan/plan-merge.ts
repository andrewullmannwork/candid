/**
 * Supplement-merge policy for `mergeIntoExistingPlan` (S286 — Andrew-approved matrix).
 *
 * Every subsequent document parse is a SUPPLEMENT to the user's existing plan
 * row, never a blind overwrite:
 *
 *   | Existing value              | New parse value  | Action                        |
 *   |-----------------------------|------------------|-------------------------------|
 *   | empty                       | found            | FILL (supplement)             |
 *   | anything                    | not found        | KEEP (never erase)            |
 *   | weak (manual / no citation) | found            | DOC WINS (CF-25 intent)       |
 *   | doc-sourced, matches        | found, same      | CONFIRM (record corroboration)|
 *   | doc-sourced, differs        | found, different | CONFLICT → per-DOCUMENT:      |
 *   |                             |                  | more complete wins; tie → new |
 *
 * Conflicts resolve per DOCUMENT, not per field — all conflicting fields follow
 * the winning document together, so the row never becomes a chimera of two
 * disagreeing reads. Cross-year and cross-insurer documents never reach this
 * code (the year-rollover and mismatch modals intercept upstream), which is why
 * "newest" only ever tie-breaks within a plan generation.
 *
 * Pure module (no server deps) so the fixture can assert the whole matrix:
 * `scripts/onboarding-simplified-fixture.ts` §8.
 */

/** Core plan-level fields used for the document-completeness score. */
export const CORE_PLAN_FIELDS = [
  "insurer_name",
  "plan_name",
  "plan_type",
  "plan_year",
  "in_deductible_individual",
  "in_deductible_family",
  "in_oop_max_individual",
  "in_oop_max_family",
  "out_deductible_individual",
  "out_deductible_family",
  "out_oop_max_individual",
  "out_oop_max_family",
] as const;

/**
 * Provenance `source` values that prove a value was read out of a document.
 * Anything else (missing entry, "manual", profile fallback, unknown) is WEAK —
 * a fresh cited parse supersedes it (CF-25: docs are the authority; manual is
 * provisional).
 */
const DOC_PROVENANCE_SOURCES = new Set([
  "doc_extraction",
  "eoc_upload",
  "eoc_parser",
  "sbc_upload",
  "sbc_parser",
  "plan_doc_upload",
]);

interface ProvenanceEntry {
  source?: unknown;
  corroborated_by?: unknown;
  [k: string]: unknown;
}

/** Is this row value backed by a document citation? */
export function isDocProvenance(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const source = (entry as ProvenanceEntry).source;
  return typeof source === "string" && DOC_PROVENANCE_SOURCES.has(source);
}

/** Empty = no data. 0 is a real value (a $0 deductible is a finding). */
function isEmpty(v: unknown): boolean {
  return v == null || v === "";
}

/** Numeric-aware, case/whitespace-insensitive equality for parsed plan values. */
export function valuesMatch(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return false;
  const na = typeof a === "number" ? a : Number(String(a).trim());
  const nb = typeof b === "number" ? b : Number(String(b).trim());
  if (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== "" && String(b).trim() !== "") {
    return na === nb;
  }
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

export type MergeAction =
  | "fill"
  | "doc_wins_weak"
  | "confirm"
  | "conflict_new_wins"
  | "conflict_existing_kept";

export interface SupplementMergeResult {
  /** The UPDATE payload for the plan row (base fields + adopted values). */
  update: Record<string, unknown>;
  /** Per-field decision log (telemetry + fixture assertions). */
  actions: Record<string, MergeAction>;
  /** Set when at least one conflict was resolved. */
  conflictWinner: "new" | "existing" | null;
}

/**
 * Apply the supplement-merge matrix.
 *
 * @param base           Housekeeping fields the merge always writes (source,
 *                       source_document_id, is_active, …, extracted-ACA).
 * @param docFields      This parse's plan-level fields (validated; profile
 *                       fallbacks stripped by the caller — document data only).
 * @param existingRow    Current plan-row values.
 * @param existingProvenance  Current `field_provenance` map on the row.
 * @param parseProvenance     This parse's per-field provenance entries.
 * @param documentId     This document's id (recorded on corroborations).
 */
export function applyDocSupplementMerge(input: {
  base: Record<string, unknown>;
  docFields: Record<string, unknown>;
  existingRow: Record<string, unknown>;
  existingProvenance: Record<string, unknown> | null | undefined;
  parseProvenance: Record<string, unknown> | null | undefined;
  documentId: string;
}): SupplementMergeResult {
  const { base, docFields, existingRow, documentId } = input;
  const existingProv = (input.existingProvenance ?? {}) as Record<string, unknown>;
  const parseProv = (input.parseProvenance ?? {}) as Record<string, unknown>;

  const update: Record<string, unknown> = { ...base };
  const actions: Record<string, MergeAction> = {};
  const provOut: Record<string, unknown> = { ...existingProv };
  let provChanged = false;
  const conflicts: string[] = [];

  // Pass 1 — classify every field this parse produced. Fields the parse did
  // NOT produce are simply absent here: KEEP by omission (never erase).
  for (const [col, parsedVal] of Object.entries(docFields)) {
    if (isEmpty(parsedVal)) continue; // not found → keep existing (never erase)
    const existingVal = existingRow[col];

    if (isEmpty(existingVal)) {
      actions[col] = "fill";
      update[col] = parsedVal;
      if (parseProv[col] != null) {
        provOut[col] = parseProv[col];
        provChanged = true;
      }
      continue;
    }

    if (!isDocProvenance(existingProv[col])) {
      // Weak incumbent (manual entry, profile fallback, uncited legacy value):
      // the cited parse supersedes it.
      actions[col] = "doc_wins_weak";
      update[col] = parsedVal;
      if (parseProv[col] != null) {
        provOut[col] = parseProv[col];
        provChanged = true;
      }
      continue;
    }

    if (valuesMatch(existingVal, parsedVal)) {
      // CONFIRM — two documents agree. Keep the original citation; record the
      // corroborating document (agreement is flywheel signal, not a no-op).
      actions[col] = "confirm";
      const entry = { ...(existingProv[col] as ProvenanceEntry) };
      const prior = Array.isArray(entry.corroborated_by)
        ? (entry.corroborated_by as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      if (!prior.includes(documentId)) {
        entry.corroborated_by = [...prior, documentId];
        provOut[col] = entry;
        provChanged = true;
      }
      continue;
    }

    conflicts.push(col);
  }

  // Pass 2 — resolve conflicts per DOCUMENT: the more complete parse wins;
  // equal completeness → the newer one (this parse) wins.
  let conflictWinner: SupplementMergeResult["conflictWinner"] = null;
  if (conflicts.length > 0) {
    const completenessNew = CORE_PLAN_FIELDS.filter((f) => !isEmpty(docFields[f])).length;
    const completenessExisting = CORE_PLAN_FIELDS.filter(
      (f) => !isEmpty(existingRow[f]) && isDocProvenance(existingProv[f]),
    ).length;
    const newWins = completenessNew >= completenessExisting;
    conflictWinner = newWins ? "new" : "existing";
    for (const col of conflicts) {
      if (newWins) {
        actions[col] = "conflict_new_wins";
        update[col] = docFields[col];
        if (parseProv[col] != null) {
          provOut[col] = parseProv[col];
          provChanged = true;
        }
      } else {
        actions[col] = "conflict_existing_kept";
      }
    }
  }

  if (provChanged) update.field_provenance = provOut;
  return { update, actions, conflictWinner };
}
