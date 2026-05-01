/**
 * EOB post-process functions per DR-3D locked decisions.
 * See plans/findings/dr3d_dogfood_findings.md for full pattern documentation.
 *
 * Pattern P-8 (Phase 3.1B) extends this with citation-grade source provenance:
 * `segmentEOBSections()` + `verifySourceExcerpts()` + extended `parseHaikuMetaBlock`
 * that captures `source_excerpt` and `source_section_hint` per field.
 */

import { createHash } from "crypto";
import type { Accumulator, BillLineItem, EOBExtractionMeta, ExCode, FieldMeta, ParsedBill } from "./types";
import type { ExtractionMethod, SectionRanges } from "../parser/types";
import { isDoNotExtractSection } from "../parser/types";

/**
 * EOB-specific section hints per Q-P3.1B-8 + Q-P3.1B-Open-1.
 * Stored as opaque strings in `field_provenance.{field}.source_section_hint` JSONB;
 * consumers format via `formatSectionHint()` in `src/lib/parser/source-display.ts`.
 *
 * Suffix `_DO_NOT_EXTRACT` is reserved for boilerplate sections — Haiku claiming a
 * field's source from these regions is a self-reported hallucination admission.
 */
export type EOBSectionHint =
  | "claim_header"
  | "line_items_table"
  | "denial_codes_section"
  | "accumulator_block"
  | "appeal_rights_DO_NOT_EXTRACT"
  | "glossary_DO_NOT_EXTRACT"
  | "footer_legalese_DO_NOT_EXTRACT"
  | "other";

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
//
// Pattern P-8 extends this to capture source_excerpt + source_section_hint per field
// alongside the confidence value. Both populate the new `fieldProvenance` map; legacy
// `fieldConfidences` map continues to be populated for backcompat.
export function parseHaikuMetaBlock(rawMeta: unknown, extractedData: ParsedBill): EOBExtractionMeta {
  const fieldConfidences: Record<string, number> = {};
  const fieldProvenance: Record<string, FieldMeta> = {};
  const warnings: string[] = [];

  // Handler 7: missing _meta entirely → empty + warn (consumer defaults to 0.85)
  if (!rawMeta || typeof rawMeta !== "object" || Array.isArray(rawMeta)) {
    warnings.push("meta_block_missing_or_malformed");
    return { fieldConfidences, fieldProvenance, warnings };
  }

  const flattened = flattenMeta(rawMeta as Record<string, unknown>, "");

  for (const [rawKey, rawValue] of Object.entries(flattened)) {
    // Handler 3: snake_case → camelCase normalization
    const key = normalizeFieldPath(rawKey);

    // Pattern P-8: capture source_excerpt + source_section_hint from the meta object
    // BEFORE confidence-extraction collapses it to a number.
    let sourceExcerpt: string | undefined;
    let sourceSectionHint: string | undefined;

    // Handler 1: nested object value → probe inner keys
    let v = rawValue;
    if (v !== null && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const excerptCandidate = obj.source_excerpt ?? obj.sourceExcerpt;
      if (typeof excerptCandidate === "string" && excerptCandidate.length > 0) {
        sourceExcerpt = excerptCandidate.length > 200 ? excerptCandidate.slice(0, 200) : excerptCandidate;
      }
      const sectionCandidate = obj.source_section_hint ?? obj.sourceSectionHint;
      if (typeof sectionCandidate === "string" && sectionCandidate.length > 0) {
        sourceSectionHint = sectionCandidate;
      }
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
    // (Even when confidence is unparseable, we still record source_excerpt + section_hint
    // if present — they don't depend on confidence being valid.)
    const isValidConfidence = !isNaN(numericValue);
    if (!isValidConfidence) {
      warnings.push(`meta_value_NaN:${key}`);
    }

    // Handler 5: clamp to [0,1]
    const clamped = isValidConfidence ? Math.max(0, Math.min(1, numericValue)) : undefined;

    // Handler 6: skip orphan keys (field doesn't exist in extracted data)
    if (!fieldExistsInData(key, extractedData)) {
      warnings.push(`meta_orphan_key:${key}`);
      continue;
    }

    if (clamped !== undefined) {
      fieldConfidences[key] = clamped;
    }

    // Pattern P-8: always populate fieldProvenance entry if we have ANY of
    // {confidence, source_excerpt, source_section_hint}. Verification of the excerpt
    // happens in verifySourceExcerpts() (separate pass — needs raw doc text).
    if (clamped !== undefined || sourceExcerpt !== undefined || sourceSectionHint !== undefined) {
      const entry: FieldMeta = {};
      if (clamped !== undefined) entry.confidence = clamped;
      if (sourceExcerpt !== undefined) entry.source_excerpt = sourceExcerpt;
      if (sourceSectionHint !== undefined) entry.source_section_hint = sourceSectionHint;
      fieldProvenance[key] = entry;
    }
  }

  return { fieldConfidences, fieldProvenance, warnings };
}

// Recursively flatten nested _meta blocks (handler 6: tolerate top-level vs nested-in-lineItems placement).
//
// Leaf detection: object is a leaf if ANY of its keys is a confidence-shape key
// (confidence/value/score/conf). Pattern P-8 added source_excerpt + source_section_hint
// alongside confidence — leaves now have multi-key shape, so .some() not .every().
function flattenMeta(obj: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const CONFIDENCE_KEYS = ["confidence", "value", "score", "conf"];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    // Stop flattening when we hit a leaf-like value (number, string, or object with confidence-shaped keys)
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      result[path] = v;
    } else {
      const inner = v as Record<string, unknown>;
      const innerKeys = Object.keys(inner);
      // Treat as leaf if ANY confidence-shape key present — additional keys like
      // source_excerpt + source_section_hint are now expected per Pattern P-8.
      const isLeaf = innerKeys.some((k) => CONFIDENCE_KEYS.includes(k));
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

// Convenience: apply all post-process functions in canonical order.
//
// Pattern P-8: when `rawDocText` and `extractionMethod` are provided, run section
// segmentation + source excerpt verification. Backwards-compatible — callers that
// don't pass them get the legacy behavior (no Pattern P-8 verification).
export function applyEOBPostProcess(
  parsed: ParsedBill,
  rawMeta: unknown,
  options?: {
    rawDocText?: string;
    extractionMethod?: ExtractionMethod;
  },
): {
  pairsFound: number;
  accumulatorsChanged: boolean;
  metaWarnings: string[];
  accumulatorWarnings: string[];
  excerptVerificationWarnings: string[];
  sectionRangesFound: number; // Pattern P-8 dogfood metric (sanity check that segmentation found sections)
} {
  const cycle = detectReversalCycles(parsed);
  const accMerge = mergeAccumulatorsByKey(parsed);
  hashAllExCodes(parsed);
  parsed.extractionMeta = parseHaikuMetaBlock(rawMeta, parsed);

  let excerptVerificationWarnings: string[] = [];
  let sectionRangesFound = 0;
  if (options?.rawDocText && options.extractionMethod) {
    const sectionRanges = segmentEOBSections(options.rawDocText);
    sectionRangesFound = Object.values(sectionRanges).reduce((acc, ranges) => acc + ranges.length, 0);
    const verifyResult = verifySourceExcerpts(
      parsed.extractionMeta.fieldProvenance,
      options.rawDocText,
      sectionRanges,
      options.extractionMethod,
    );
    parsed.extractionMeta.fieldProvenance = verifyResult.fieldProvenance;
    excerptVerificationWarnings = verifyResult.warnings;
  }

  return {
    pairsFound: cycle.pairsFound,
    accumulatorsChanged: accMerge.changed,
    metaWarnings: parsed.extractionMeta.warnings,
    accumulatorWarnings: accMerge.warnings,
    excerptVerificationWarnings,
    sectionRangesFound,
  };
}

/**
 * Pattern P-8 — segment raw EOB document text into named regions.
 *
 * Returns a map of EOB section hint → list of half-open character ranges where
 * that section appears in `rawDocText`. Each section can have multiple ranges
 * (e.g., multi-claim EOBs may have multiple "CLAIM DETAIL" sections).
 *
 * Heuristic: scan rawDocText for anchored heading lines per section. A section
 * starts at the heading match index and ends at the next heading (any section)
 * OR end-of-text. This is best-effort — Q-P3.1B-7 sets a 90% match-rate target,
 * acknowledging insurer-specific heading variations may produce gaps.
 */
export function segmentEOBSections(rawDocText: string): SectionRanges {
  // Anchored regex per section type. Heading must be at the start of a line, optionally
  // preceded by whitespace (Cigna EOBs indent section headers, others don't). Avoids
  // catching body-text references like "see CLAIM DETAIL above" because those are mid-line.
  const sectionPatterns: Array<[EOBSectionHint, RegExp]> = [
    [
      "claim_header",
      /^\s*(EXPLANATION OF BENEFITS|HEALTH STATEMENT|HEALTHCARE STATEMENT|HEALTH CARE SUMMARY|SUMMARY OF (?:A )?CLAIM)\b/im,
    ],
    [
      "line_items_table",
      /^\s*(CLAIM DETAIL|SERVICE DETAIL|CLAIM SUMMARY|SERVICES RECEIVED|DETAIL OF SERVICES|YOUR CLAIM DETAIL|FOR SERVICES PROVIDED BY)\b/im,
    ],
    [
      "denial_codes_section",
      /^\s*(EXPLANATION CODES?|REASON CODES?|(CARC|RARC|EX) CODE.*(DESCRIPTION|CODE)|NOTES.*REASON|WHY WE MADE THIS DECISION|NOTES \/ REASON CODES|^\s*NOTES\s*$)\b/im,
    ],
    [
      "accumulator_block",
      /^\s*(ACCUMULATOR(\s+(INFORMATION|STATUS))?|YOUR PLAN BENEFITS SUMMARY|DEDUCTIBLE STATUS|OUT.OF.POCKET STATUS|ANNUAL DEDUCTIBLE STATUS|PLAN YEAR DEDUCTIBLE)\b/im,
    ],
    [
      "appeal_rights_DO_NOT_EXTRACT",
      /^\s*(NOTICE OF YOUR APPEAL RIGHTS|HOW TO APPEAL|YOUR RIGHT TO APPEAL|APPEAL RIGHTS|FEDERAL RIGHTS OF (?:REVIEW AND )?APPEAL)\b/im,
    ],
    [
      "footer_legalese_DO_NOT_EXTRACT",
      /^\s*(YOUR RIGHTS AND PROTECTIONS|SURPRISE MEDICAL BILLS|NO SURPRISES ACT)\b/im,
    ],
    [
      "glossary_DO_NOT_EXTRACT",
      /^\s*(GLOSSARY|DEFINITIONS|TERMS YOU MAY SEE|WHAT (?:THIS|IT) MEANS|KEY TERMS)\b/im,
    ],
  ];

  // First pass: find ALL match indices per section (multiple instances allowed).
  const matches: Array<{ hint: EOBSectionHint; start: number }> = [];
  for (const [hint, pattern] of sectionPatterns) {
    const flagged = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = flagged.exec(rawDocText)) !== null) {
      matches.push({ hint, start: m.index });
    }
  }

  // Sort by character offset; each section's range ends at the NEXT heading
  // (any section type) or end-of-text.
  matches.sort((a, b) => a.start - b.start);

  const result: SectionRanges = {};
  for (let i = 0; i < matches.length; i++) {
    const { hint, start } = matches[i];
    const end = i + 1 < matches.length ? matches[i + 1].start : rawDocText.length;
    if (!result[hint]) result[hint] = [];
    result[hint].push({ start, end });
  }

  return result;
}

/**
 * Pattern P-8 — verify per-field source excerpts against raw doc text + section ranges.
 *
 * Three-state verification per Q-P3.1B-6 v2 (no fuzzy matching at any extraction method):
 *   - exact substring match → source_excerpt_verified='verified'
 *   - extraction_method='ocr' AND no exact match → 'ocr_unverifiable'
 *   - any other method, no match → 'not_found'
 *
 * Section attribution (Tier 2): if `source_section_hint` is provided AND that section
 * is in `sectionRanges`, check that the excerpt appears within ANY of the named section's
 * text-ranges → source_section_verified=true. Else false.
 *
 * Hallucination guard: if `source_section_hint` ends with `_DO_NOT_EXTRACT`, force
 * source_excerpt_verified='not_found' AND source_section_verified=false; emit warning.
 *
 * Mutates a copy of `fieldProvenance` (does not modify the input). Returns the new
 * map plus a warnings list (do_not_extract pulls, missing sections, etc.).
 */
export function verifySourceExcerpts(
  fieldProvenance: Record<string, FieldMeta>,
  rawDocText: string,
  sectionRanges: SectionRanges,
  extractionMethod: ExtractionMethod,
): {
  fieldProvenance: Record<string, FieldMeta>;
  warnings: string[];
} {
  const warnings: string[] = [];
  const out: Record<string, FieldMeta> = {};

  for (const [fieldPath, meta] of Object.entries(fieldProvenance)) {
    const updated: FieldMeta = { ...meta };

    if (!meta.source_excerpt) {
      // No excerpt to verify; carry over as-is.
      out[fieldPath] = updated;
      continue;
    }

    updated.source_excerpt_extraction_method = extractionMethod;

    // Hallucination guard: DO_NOT_EXTRACT sections force verified='not_found'.
    if (isDoNotExtractSection(meta.source_section_hint)) {
      updated.source_excerpt_verified = "not_found";
      updated.source_section_verified = false;
      warnings.push(`source_section_do_not_extract:${fieldPath}:${meta.source_section_hint}`);
      out[fieldPath] = updated;
      continue;
    }

    // Tier 1: exact substring match against full raw doc text.
    const matched = rawDocText.includes(meta.source_excerpt);
    if (matched) {
      updated.source_excerpt_verified = "verified";
    } else if (extractionMethod === "ocr") {
      // No fuzzy fallback — explicit 'ocr_unverifiable' signal per Q-P3.1B-6 v2.
      updated.source_excerpt_verified = "ocr_unverifiable";
      warnings.push(`source_excerpt_ocr_unverifiable:${fieldPath}`);
    } else {
      updated.source_excerpt_verified = "not_found";
      warnings.push(`source_excerpt_not_found:${fieldPath}`);
    }

    // Tier 2: section attribution — excerpt appears within named section's text-range?
    if (meta.source_section_hint && sectionRanges[meta.source_section_hint]?.length) {
      const ranges = sectionRanges[meta.source_section_hint];
      const inSection = ranges.some(({ start, end }) => {
        const sectionText = rawDocText.slice(start, end);
        return sectionText.includes(meta.source_excerpt!);
      });
      updated.source_section_verified = inSection;
      if (!inSection && updated.source_excerpt_verified === "verified") {
        // Excerpt is in the doc but not in the named section — likely semantic mis-attribution.
        warnings.push(`source_section_mismatch:${fieldPath}:${meta.source_section_hint}`);
      }
    } else {
      updated.source_section_verified = false;
      if (meta.source_section_hint) {
        warnings.push(`source_section_unknown:${fieldPath}:${meta.source_section_hint}`);
      }
    }

    out[fieldPath] = updated;
  }

  return { fieldProvenance: out, warnings };
}
