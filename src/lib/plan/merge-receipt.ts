/**
 * Merge receipts — what it takes to make "This isn't my plan" actually undo
 * something (S292 item 4C).
 *
 * WHY A RECEIPT AND NOT A PROVENANCE WALK
 * At the 0.85 identity floor the supplement-merge lands BEFORE the user ever
 * sees the confirmation, so the escape hatch has to REVERT, not prevent. But
 * nothing in the schema can reconstruct the prior state after the fact:
 *
 *   • `applyDocSupplementMerge` overwrites the plan column AND its
 *     `field_provenance` entry in the same write, so the previous citation is
 *     gone along with the previous value.
 *   • `plan_covered_services` cells upsert on the 5-col key, so an overwritten
 *     cell's old cost-share is destroyed in place.
 *   • `field_provenance` records which SOURCE a value came from, never the
 *     value it replaced.
 *
 * So provenance can tell us WHICH fields a document touched, but never what
 * they held before. That is the mig-217 lesson in a third location: the
 * information exists only at write time, and an undo that isn't captured then
 * isn't recoverable later. Hence a receipt, written immediately before the
 * merge.
 *
 * COMPARE-AND-SWAP, NOT BLIND RESTORE
 * A user can correct a value between the merge and the unwind (the assumptions
 * card writes straight to these columns). Blindly restoring the pre-merge state
 * would silently destroy that correction — the same class of harm mig 217 was
 * blocked for. So a field is reverted ONLY if it still holds exactly what the
 * merge wrote. Anything the user has since changed is left alone and reported,
 * so the caller can say so rather than pretend a full undo happened.
 *
 * Pure + synchronous: no Supabase, no I/O. The DB work lives in the route.
 */

/** Receipt schema version — bump if the shape changes so old receipts stay readable. */
export const PLAN_MERGE_RECEIPT_VERSION = 1;

/**
 * Above this many coverage cells we refuse to promise a service-level undo.
 * A silent truncation would produce a receipt that LOOKS complete and reverts
 * only part of the plan — worse than declining, because the user would be told
 * the merge was undone. `servicesUnwindable: false` says so out loud instead.
 */
export const MAX_RECEIPT_CELLS = 400;

export interface CoverageCellKey {
  service_id: string;
  place_of_service: string;
  component: string;
  plan_tier_label: string;
}

export interface PlanMergeReceipt {
  version: number;
  documentId: string;
  targetPlanId: string;
  mergedAt: string;
  /** Plan-row columns: what they held before, and what the merge wrote. */
  plan: {
    before: Record<string, unknown>;
    wrote: Record<string, unknown>;
  };
  /** The whole `field_provenance` map as it stood before the merge. */
  provenanceBefore: Record<string, unknown> | null;
  profile: {
    before: Record<string, unknown>;
    wrote: Record<string, unknown>;
  } | null;
  /**
   * Pre-image of every coverage cell on the target plan at merge time. Absent
   * cells (ones the document went on to create) are identified on unwind by
   * key difference, so they can be deleted rather than restored.
   */
  cellsBefore: Array<{ key: CoverageCellKey; row: Record<string, unknown> }>;
  /** False when the snapshot was declined (too many cells) — never a silent cap. */
  servicesUnwindable: boolean;
  /** Set once the unwind runs, so a double-click can't revert twice. */
  unwoundAt?: string;
}

/** Housekeeping columns a revert must never restore — they describe the row, not the plan. */
const NEVER_REVERT = new Set(["id", "user_id", "created_at", "updated_at"]);

/**
 * Numeric-aware equality, matching `plan-merge.ts` `valuesMatch` semantics so
 * "did this field still hold what the merge wrote?" is judged the same way the
 * merge judged "did these two documents agree?".
 *
 * Differs in ONE deliberate way: null equals null here. `valuesMatch` treats
 * null as never-matching because a missing parse can't corroborate anything;
 * for compare-and-swap, a field the merge left null and that is STILL null has
 * demonstrably not been touched by the user, which is exactly what we're asking.
 */
export function sameStoredValue(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  const na = typeof a === "number" ? a : Number(String(a).trim());
  const nb = typeof b === "number" ? b : Number(String(b).trim());
  if (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== "" && String(b).trim() !== "") {
    return na === nb;
  }
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

export interface RevertPlan {
  /** Columns to write back, already compare-and-swap filtered. */
  patch: Record<string, unknown>;
  /** Columns left alone because the user changed them after the merge. */
  keptByUser: string[];
}

/**
 * Compute the plan-row revert.
 *
 * @param receipt  the receipt captured at merge time
 * @param current  the plan row as it stands NOW
 */
export function buildPlanRevertPatch(
  receipt: PlanMergeReceipt,
  current: Record<string, unknown>,
): RevertPlan {
  const patch: Record<string, unknown> = {};
  const keptByUser: string[] = [];

  for (const [col, wroteVal] of Object.entries(receipt.plan.wrote)) {
    if (NEVER_REVERT.has(col)) continue;
    // `field_provenance` is restored wholesale below, not per-column — reverting
    // it here would race the map-level restore and could leave a citation
    // pointing at a value that no longer exists.
    if (col === "field_provenance") continue;

    if (!sameStoredValue(current[col], wroteVal)) {
      // Someone (the user, a later document) changed this since the merge.
      // Their value is newer evidence than our undo — leave it.
      keptByUser.push(col);
      continue;
    }
    patch[col] = receipt.plan.before[col] ?? null;
  }

  // Provenance is restored as a whole map: it is the record of WHY each column
  // holds what it holds, so a partial restore would attribute reverted values to
  // the document that has just been disowned.
  if (receipt.provenanceBefore !== undefined) {
    patch.field_provenance = receipt.provenanceBefore ?? {};
  }

  return { patch, keptByUser };
}

/** Same compare-and-swap rule for the profile's denormalized plan identity. */
export function buildProfileRevertPatch(
  receipt: PlanMergeReceipt,
  current: Record<string, unknown>,
): RevertPlan {
  const patch: Record<string, unknown> = {};
  const keptByUser: string[] = [];
  if (!receipt.profile) return { patch, keptByUser };

  for (const [col, wroteVal] of Object.entries(receipt.profile.wrote)) {
    if (!sameStoredValue(current[col], wroteVal)) {
      keptByUser.push(col);
      continue;
    }
    patch[col] = receipt.profile.before[col] ?? null;
  }
  return { patch, keptByUser };
}

/** Stable string key for a coverage cell — mirrors the 5-col storage UNIQUE. */
export function cellKeyOf(k: CoverageCellKey): string {
  return `${k.service_id}|${k.place_of_service}|${k.component}|${k.plan_tier_label}`;
}

export interface CellRevert {
  /** Cells to write back to their pre-merge values. */
  restore: Array<Record<string, unknown>>;
  /** Cells that did not exist before the merge and are attributable to this document. */
  deleteKeys: CoverageCellKey[];
  /** Cells created after the merge by something else — left alone, and reported. */
  keptByUser: number;
}

/**
 * Compute the coverage-cell revert.
 *
 * A cell present now but absent from the snapshot was created after the merge
 * began. It is deleted ONLY when its `field_provenance` cites this document —
 * otherwise it is somebody else's row (a later upload, a manual entry) that
 * merely happens to postdate the merge, and deleting it would be the data loss
 * this whole mechanism exists to avoid.
 */
export function buildCellRevert(
  receipt: PlanMergeReceipt,
  currentCells: Array<Record<string, unknown>>,
  citesDocument: (row: Record<string, unknown>, documentId: string) => boolean,
): CellRevert {
  const before = new Map(receipt.cellsBefore.map((c) => [cellKeyOf(c.key), c.row]));
  const restore: Array<Record<string, unknown>> = [];
  const deleteKeys: CoverageCellKey[] = [];
  let keptByUser = 0;

  for (const row of currentCells) {
    const key: CoverageCellKey = {
      service_id: String(row.service_id ?? ""),
      place_of_service: String(row.place_of_service ?? "any"),
      component: String(row.component ?? "global"),
      plan_tier_label: String(row.plan_tier_label ?? "none"),
    };
    const prior = before.get(cellKeyOf(key));
    if (prior) {
      restore.push(prior);
      continue;
    }
    if (citesDocument(row, receipt.documentId)) deleteKeys.push(key);
    else keptByUser++;
  }

  return { restore, deleteKeys, keptByUser };
}

/**
 * Does this row's `field_provenance` cite the given document?
 *
 * Checks BOTH the originating citation (`source_document_id`, when a writer
 * records it) and the `corroborated_by` arrays the supplement-merge appends —
 * a cell the document merely confirmed is not the document's to delete, but a
 * cell it created is.
 */
export function provenanceCitesDocument(
  row: Record<string, unknown>,
  documentId: string,
): boolean {
  if (row.source_document_id === documentId) return true;
  const prov = row.field_provenance;
  if (typeof prov !== "object" || prov === null) return false;
  for (const entry of Object.values(prov as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (e.source_document_id === documentId) return true;
    if (Array.isArray(e.corroborated_by) && e.corroborated_by.includes(documentId)) return true;
  }
  return false;
}
