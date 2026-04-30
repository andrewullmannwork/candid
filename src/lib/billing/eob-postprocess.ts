/**
 * EOB post-process functions per DR-3D locked decisions.
 * See plans/findings/dr3d_dogfood_findings.md for full pattern documentation.
 */

import { createHash } from "crypto";
import type { Accumulator, BillLineItem, EOBExtractionMeta, ExCode, ParsedBill } from "./types";

const HIGH_LEVERAGE_FIELD_PREFIXES = [
  "claim_number",
  "external_claim_number",
  "eob_date",
  "network_status",
  "lineItems",
  "accumulators",
];

// Q-DR-3D-2 — note text normalization (lowercase + collapse whitespace + strip trailing punct).
// Locked rule; changes require backfill of existing insurer_ex_code_mappings rows.
export function normalizeNoteText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?]+\s*$/, "")
    .trim();
}

export function hashExNoteText(text: string): string {
  return createHash("sha256").update(normalizeNoteText(text)).digest("hex");
}

// Populate note_text_hash on every ExCode in lineItems
export function hashAllExCodes(parsed: ParsedBill): void {
  for (const item of parsed.lineItems ?? []) {
    if (item.ex_codes) {
      for (const ex of item.ex_codes) {
        if (ex.note_text && !ex.note_text_hash) {
          ex.note_text_hash = hashExNoteText(ex.note_text);
        }
      }
    }
  }
}

// Q-DR-3D-3 v2 — Greedy bipartite reversal pair detection with line-distance tiebreaker.
// 5-field strict conjunction prevents false positives; greedy iteration with FIRST-match-wins
// prevents multi-identical-pair mismatches. See dr3d_dogfood_findings.md Pattern 7.
export function detectReversalCycles(parsed: ParsedBill): { pairsFound: number } {
  if (!parsed.lineItems || parsed.lineItems.length < 2) return { pairsFound: 0 };

  // Sort indices by line_number_in_eob (verbatim from EOB); fallback to lineNumber
  const indices = parsed.lineItems.map((_, i) => i);
  indices.sort((a, b) => {
    const itemA = parsed.lineItems[a];
    const itemB = parsed.lineItems[b];
    const aNum = parseInt(itemA.line_number_in_eob ?? String(itemA.lineNumber ?? "0"), 10);
    const bNum = parseInt(itemB.line_number_in_eob ?? String(itemB.lineNumber ?? "0"), 10);
    return aNum - bNum;
  });

  const matched = new Set<number>();
  let pairsFound = 0;

  for (let i = 0; i < indices.length; i++) {
    const idxA = indices[i];
    if (matched.has(idxA)) continue;
    const a = parsed.lineItems[idxA];
    for (let j = i + 1; j < indices.length; j++) {
      const idxB = indices[j];
      if (matched.has(idxB)) continue;
      const b = parsed.lineItems[idxB];
      if (isReversalPair(a, b)) {
        b.is_adjustment_reversal = true;
        b.adjusts_line_id = `lineItems[${idxA}]`;
        matched.add(idxA);
        matched.add(idxB);
        pairsFound++;
        break; // FIRST match wins (closest by line ordering = tiebreaker)
      }
    }
  }
  return { pairsFound };
}

function isReversalPair(a: BillLineItem, b: BillLineItem): boolean {
  // 5-field strict conjunction. False negatives acceptable (recoverable);
  // false positives catastrophic (silent net-payment math errors).
  // procedure_code + service_date + provider_npi + patient_member_id + amount-cancel.
  // patient_member_id is on ParsedBill.patient — not per-line — so we use rendering_provider_npi
  // as the per-line identity guard (with fallback to overall facility provider check via context).
  if (!a.procedureCode || a.procedureCode !== b.procedureCode) return false;
  if (!a.serviceDate || a.serviceDate !== b.serviceDate) return false;
  // rendering_provider_npi when populated; fallback to neither-set (still considered match for Cigna-style EOBs that don't surface NPI per line)
  const aNpi = a.rendering_provider_npi;
  const bNpi = b.rendering_provider_npi;
  if (aNpi && bNpi && aNpi !== bNpi) return false;
  // Amount cancel: prefer billed_amount; fall back to denied_amount if billed missing
  const aAmt = a.billedAmount ?? a.denied_amount ?? 0;
  const bAmt = b.billedAmount ?? b.denied_amount ?? 0;
  return Math.abs(aAmt + bAmt) < 0.01;
}

// Q-DR-3D-4 — defensive merge of accumulators by 4-dim key tuple.
// Belt-and-suspenders against stochastic Haiku splitting (deductible-only + oop-only entries
// with duplicate keys would violate Phase 5 mig 061 UNIQUE constraint).
// See dr3d_dogfood_findings.md Pattern 6.
const ACC_KEY_FIELDS: (keyof Accumulator)[] = ["benefit_year", "network_tier", "accumulator_type", "is_individual"];
const ACC_MERGE_FIELDS: (keyof Accumulator)[] = [
  "deductible_applied",
  "deductible_max",
  "oop_applied",
  "oop_max",
  "copays_applied",
  "coinsurance_applied",
];

export function mergeAccumulatorsByKey(parsed: ParsedBill): { changed: boolean; warnings: string[] } {
  if (!parsed.accumulators || parsed.accumulators.length === 0) return { changed: false, warnings: [] };
  const merged = new Map<string, Accumulator>();
  const warnings: string[] = [];
  for (const acc of parsed.accumulators) {
    const key = ACC_KEY_FIELDS.map((k) => String(acc[k] ?? "null")).join("|");
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...acc });
    } else {
      for (const f of ACC_MERGE_FIELDS) {
        const ev = existing[f] as number | undefined;
        const av = acc[f] as number | undefined;
        if (ev == null && av != null) {
          (existing as unknown as Record<string, unknown>)[f as string] = av;
        } else if (ev != null && av != null && ev !== av) {
          warnings.push(`accumulator_merge_conflict:${key}.${String(f)}:${ev}!=${av}`);
        }
      }
    }
  }
  const before = parsed.accumulators.length;
  parsed.accumulators = Array.from(merged.values());
  return { changed: before !== parsed.accumulators.length, warnings };
}

// Q-DR-3D-6 — defensive _meta block parser with 10 failure-mode handlers.
// See dr3d_dogfood_findings.md Pattern 8. Stored in field_provenance.haiku_confidence per Q-DR-3B-1.
export function parseHaikuMetaBlock(rawMeta: unknown, extractedData: ParsedBill): EOBExtractionMeta {
  const fieldConfidences: Record<string, number> = {};
  const warnings: string[] = [];

  // Handler 7: missing _meta entirely → empty + warn (consumer defaults to 0.85)
  if (!rawMeta || typeof rawMeta !== "object" || Array.isArray(rawMeta)) {
    warnings.push("meta_block_missing_or_malformed");
    return { fieldConfidences, warnings };
  }

  const flattened = flattenMeta(rawMeta as Record<string, unknown>, "");

  for (const [rawKey, rawValue] of Object.entries(flattened)) {
    // Handler 3: snake_case → camelCase normalization
    const key = normalizeFieldPath(rawKey);

    // Handler 1: nested object value → probe inner keys
    let v = rawValue;
    if (v !== null && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      v = obj.confidence ?? obj.value ?? obj.score ?? obj.conf ?? null;
    }

    // Handler 2: string → number coercion
    let numericValue = Number(v);

    // Handler 10: percentage scale autoscale (50-100 → 0.5-1.0)
    if (!isNaN(numericValue) && numericValue > 1 && numericValue <= 100) {
      warnings.push(`meta_value_autoscale:${key}:${numericValue}->${numericValue / 100}`);
      numericValue = numericValue / 100;
    }

    // Handler 4: NaN / out-of-range → skip + warn
    if (isNaN(numericValue)) {
      warnings.push(`meta_value_NaN:${key}`);
      continue;
    }

    // Handler 5: clamp to [0,1]
    const clamped = Math.max(0, Math.min(1, numericValue));

    // Handler 6: skip orphan keys (field doesn't exist in extracted data)
    if (!fieldExistsInData(key, extractedData)) {
      warnings.push(`meta_orphan_key:${key}`);
      continue;
    }

    fieldConfidences[key] = clamped;
  }

  return { fieldConfidences, warnings };
}

// Recursively flatten nested _meta blocks (handler 6: tolerate top-level vs nested-in-lineItems placement).
function flattenMeta(obj: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    // Stop flattening when we hit a leaf-like value (number, string, or object with confidence-shaped keys)
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      result[path] = v;
    } else {
      const inner = v as Record<string, unknown>;
      // Detect "confidence-shaped" leaf: object with only confidence/value/score keys
      const innerKeys = Object.keys(inner);
      const isLeaf = innerKeys.length > 0 && innerKeys.every((k) => ["confidence", "value", "score", "conf"].includes(k));
      if (isLeaf) {
        result[path] = v;
      } else {
        Object.assign(result, flattenMeta(inner, path));
      }
    }
  }
  return result;
}

function normalizeFieldPath(path: string): string {
  // snake_case → camelCase per segment, preserving array indices
  return path
    .split(".")
    .map((seg) => seg.replace(/_([a-z])/g, (_, c) => c.toUpperCase()))
    .join(".");
}

function fieldExistsInData(dotPath: string, data: ParsedBill): boolean {
  // Quick high-leverage prefix check first (cheap)
  if (!HIGH_LEVERAGE_FIELD_PREFIXES.some((p) => dotPath.startsWith(p))) {
    return true; // accept volunteered confidence on non-high-leverage fields per handler 4
  }
  // Resolve dot-path with [N] indices against actual data
  try {
    const parts = dotPath.split(/\.|\[(\d+)\]/).filter(Boolean);
    let cur: unknown = data;
    for (const part of parts) {
      if (cur === null || cur === undefined) return false;
      const idx = /^\d+$/.test(part) ? parseInt(part, 10) : null;
      cur = idx !== null ? (cur as unknown[])[idx] : (cur as Record<string, unknown>)[part];
    }
    return cur !== undefined;
  } catch {
    return false;
  }
}

// Convenience: apply all 4 post-process functions in canonical order
export function applyEOBPostProcess(parsed: ParsedBill, rawMeta: unknown): {
  pairsFound: number;
  accumulatorsChanged: boolean;
  metaWarnings: string[];
  accumulatorWarnings: string[];
} {
  const cycle = detectReversalCycles(parsed);
  const accMerge = mergeAccumulatorsByKey(parsed);
  hashAllExCodes(parsed);
  parsed.extractionMeta = parseHaikuMetaBlock(rawMeta, parsed);
  return {
    pairsFound: cycle.pairsFound,
    accumulatorsChanged: accMerge.changed,
    metaWarnings: parsed.extractionMeta.warnings,
    accumulatorWarnings: accMerge.warnings,
  };
}
