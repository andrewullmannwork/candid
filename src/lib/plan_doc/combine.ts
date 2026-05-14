/**
 * Plan_doc field-merge helpers (S73 — Session 76).
 *
 * Phase 3.1A.1 mechanism inheritance: when a section is sub-segmented into chunks
 * OR a field is extracted from multiple sections (multi-section dispatch), merge
 * results into a single coherent output by picking the first non-null value per
 * scalar field AND merging arrays/objects per the field's semantics.
 *
 * Multi-section dispatch (S73):
 *   - planIdentity scalars often appear scattered across sections (cover preamble +
 *     plan_identity section + services schedule headers). Run planIdentity Haiku on
 *     multiple sections; field-merge picks the first non-null value per field.
 *   - accessInstructions scalars (customer service phone, network URL) often appear
 *     in services schedule AND dedicated access section. Same merge pattern.
 *
 * Within-section sub-segmentation:
 *   - Large sections (e.g., Kaiser 102+ services) split into line/paragraph chunks
 *     to fit Haiku's 8K output-token limit. Each chunk produces a partial result;
 *     merge concatenates services arrays + picks first scalar.
 *
 * Pattern P-8 provenance preservation: the source_section_hint of the WINNING chunk
 * (the chunk that contributed a non-null value) is preserved on the merged field —
 * critical for the verifier to know which section to check excerpt against.
 */

import type {
  PlanDocAccessInstructions,
  PlanDocField,
  PlanDocPatternP8Provenance,
  PlanDocPlanIdentity,
  PlanDocSectionResult,
  PlanDocService,
} from "./types";

// ── PlanIdentity field-merge ───────────────────────────────────────────────

type PlanIdentityKey = keyof PlanDocPlanIdentity;

const PLAN_IDENTITY_KEYS: readonly PlanIdentityKey[] = [
  "planName",
  "insurerName",
  "planType",
  "metalTier",
  "planYear",
  "groupNumber",
  "networkType",
  "deductibleIndividual",
  "deductibleFamily",
  "oopMaxIndividual",
  "oopMaxFamily",
  "outDeductibleIndividual",
  "outDeductibleFamily",
  "outOopMaxIndividual",
  "outOopMaxFamily",
  "isAcaCompliant",
  "acaComplianceBasis",
] as const;

function isNonNullValue<T>(field: PlanDocField<T | null> | undefined): field is PlanDocField<T> {
  return field !== undefined && field.value !== null && field.value !== undefined;
}

/**
 * Pick the first non-null value across N chunks for a given plan-identity field.
 * Preserves the Pattern P-8 provenance of the winning chunk.
 *
 * If all chunks return null, returns the FIRST chunk's field (empty P-8; null value).
 * This preserves a placeholder Pattern P-8 entry for downstream verbatim_absent
 * derivation in the verifier.
 *
 * Tie-break: when multiple chunks contribute non-null values, prefer the chunk with
 * the higher haikuConfidence (Haiku's self-reported certainty) — proxy for verbatim
 * quality. If confidences tie, first chunk wins (caller controls ordering).
 */
function pickBestPlanIdentityField<T>(
  fields: Array<PlanDocField<T | null> | undefined>,
): PlanDocField<T | null> {
  const populated = fields.filter(isNonNullValue);
  if (populated.length === 0) {
    // Return first chunk's field if any; else a synthetic empty (caller responsibility
    // to ensure at least one chunk's field is non-undefined).
    for (const f of fields) {
      if (f !== undefined) return f;
    }
    throw new Error("pickBestPlanIdentityField: no chunks provided");
  }
  if (populated.length === 1) return populated[0];
  return populated.reduce((best, cur) => {
    const bestConf = best.haikuConfidence ?? 0;
    const curConf = cur.haikuConfidence ?? 0;
    return curConf > bestConf ? cur : best;
  });
}

/**
 * Merge plan-identity results from N chunks (sub-segments OR multi-section dispatch).
 * Field-merge per scalar: first non-null wins, tiebreak by Haiku confidence.
 *
 * Each scalar key is merged independently via pickBest helper. TypeScript can't infer
 * the cross-key union (string vs number values), so we cast per key inside the loop.
 */
export function mergePlanIdentityChunks(
  chunks: Array<PlanDocPlanIdentity | null>,
): PlanDocPlanIdentity {
  const valid = chunks.filter((c): c is PlanDocPlanIdentity => c !== null);
  if (valid.length === 0) {
    throw new Error("mergePlanIdentityChunks: no valid chunks provided");
  }

  const pickKey = <K extends PlanIdentityKey>(
    key: K,
  ): PlanDocPlanIdentity[K] => {
    const fieldChunks = valid.map((c) => c[key]);
    return pickBestPlanIdentityField(
      fieldChunks as Array<PlanDocField<unknown | null> | undefined>,
    ) as PlanDocPlanIdentity[K];
  };

  return {
    planName: pickKey("planName"),
    insurerName: pickKey("insurerName"),
    planType: pickKey("planType"),
    metalTier: pickKey("metalTier"),
    planYear: pickKey("planYear"),
    groupNumber: pickKey("groupNumber"),
    networkType: pickKey("networkType"),
    deductibleIndividual: pickKey("deductibleIndividual"),
    deductibleFamily: pickKey("deductibleFamily"),
    oopMaxIndividual: pickKey("oopMaxIndividual"),
    oopMaxFamily: pickKey("oopMaxFamily"),
    outDeductibleIndividual: pickKey("outDeductibleIndividual"),
    outDeductibleFamily: pickKey("outDeductibleFamily"),
    outOopMaxIndividual: pickKey("outOopMaxIndividual"),
    outOopMaxFamily: pickKey("outOopMaxFamily"),
    isAcaCompliant: pickKey("isAcaCompliant"),
    acaComplianceBasis: pickKey("acaComplianceBasis"),
  };
}

// ── Services array merge ───────────────────────────────────────────────────

/**
 * Merge services arrays from N chunks. Dedup by (serviceSlug, placeOfService) — same
 * service in the same place from different chunks (e.g., chunk boundary split) keeps
 * the one with the higher haikuConfidence. Different services accumulate.
 *
 * Per-service Pattern P-8 source_excerpt is per-row, so dedup-by-key keeps the
 * higher-confidence row's excerpt naturally.
 */
export function mergeServicesChunks(chunks: Array<PlanDocService[]>): PlanDocService[] {
  const byKey = new Map<string, PlanDocService>();
  for (const svcArr of chunks) {
    for (const svc of svcArr) {
      const key = `${svc.serviceSlug}|${svc.placeOfService ?? ""}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, svc);
        continue;
      }
      const existingConf = existing.haikuConfidence ?? 0;
      const curConf = svc.haikuConfidence ?? 0;
      if (curConf > existingConf) {
        byKey.set(key, svc);
      }
    }
  }
  return Array.from(byKey.values());
}

// ── AccessInstructions field-merge ────────────────────────────────────────

/**
 * Merge access-instructions results from N chunks. customerServicePhone +
 * networkFinderUrl follow first-non-null-wins. domainContacts maps merge with
 * later-chunk values overriding earlier (last-write-wins per key) — diverging
 * domain contacts within a single document are rare; if it happens, the later
 * section's value is typically the more canonical (e.g., dedicated access section
 * overrides services-schedule callout).
 */
export function mergeAccessInstructionsChunks(
  chunks: Array<PlanDocAccessInstructions | null>,
): PlanDocAccessInstructions | null {
  const valid = chunks.filter((c): c is PlanDocAccessInstructions => c !== null);
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0];

  const customerServicePhone = pickBestPlanIdentityField(
    valid.map((c) => c.customerServicePhone) as Array<PlanDocField<string | null>>,
  ) as PlanDocField<string | null>;
  const networkFinderUrl = pickBestPlanIdentityField(
    valid.map((c) => c.networkFinderUrl) as Array<PlanDocField<string | null>>,
  ) as PlanDocField<string | null>;

  const domainContacts: Record<string, string> = {};
  for (const c of valid) {
    for (const [domain, phone] of Object.entries(c.domainContacts)) {
      domainContacts[domain] = phone;
    }
  }
  // Pick first non-null domainContactsPatternP8 (provenance is approximate when merging
  // across chunks; downstream verifier checks substring presence regardless).
  const domainContactsPatternP8 = valid.find((c) => c.domainContactsPatternP8 !== null)
    ?.domainContactsPatternP8 ?? null;

  return {
    customerServicePhone,
    networkFinderUrl,
    domainContacts,
    domainContactsPatternP8,
  };
}

// ── SectionResult-level helpers (sum telemetry across chunks) ────────────

export interface SectionTelemetry {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  warnings: string[];
}

export function sumSectionTelemetry<T>(
  chunks: Array<PlanDocSectionResult<T> | null>,
): SectionTelemetry {
  const valid = chunks.filter((c): c is PlanDocSectionResult<T> => c !== null);
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  const warnings: string[] = [];
  for (const c of valid) {
    inputTokens += c.haiku_input_tokens;
    outputTokens += c.haiku_output_tokens;
    costUsd += c.haiku_cost_usd;
    warnings.push(...c.warnings);
  }
  return { inputTokens, outputTokens, costUsd, warnings };
}

// ── Type-narrowed re-export for parser consumers ──────────────────────────

export function planIdentityHasAnyPopulated(pi: PlanDocPlanIdentity): boolean {
  for (const key of PLAN_IDENTITY_KEYS) {
    if (pi[key].value !== null && pi[key].value !== undefined) return true;
  }
  return false;
}

export function emptyPatternP8(
  extractionMethod: PlanDocPatternP8Provenance["source_excerpt_extraction_method"],
  sectionHint: PlanDocPatternP8Provenance["source_section_hint"],
): PlanDocPatternP8Provenance {
  return {
    source_excerpt: "",
    source_excerpt_verified: "not_found",
    source_excerpt_extraction_method: extractionMethod,
    source_section_hint: sectionHint,
    source_section_verified: false,
  };
}

export function emptyPlanIdentity(
  extractionMethod: PlanDocPatternP8Provenance["source_excerpt_extraction_method"],
): PlanDocPlanIdentity {
  const p8 = emptyPatternP8(extractionMethod, "plan_identity");
  const emptyString: PlanDocField<string | null> = { value: null, patternP8: p8 };
  const emptyNumber: PlanDocField<number | null> = { value: null, patternP8: p8 };
  return {
    planName: { ...emptyString, patternP8: { ...p8 } },
    insurerName: { ...emptyString, patternP8: { ...p8 } },
    planType: { ...emptyString, patternP8: { ...p8 } },
    metalTier: { ...emptyString, patternP8: { ...p8 } },
    planYear: { ...emptyNumber, patternP8: { ...p8 } },
    groupNumber: { ...emptyString, patternP8: { ...p8 } },
    networkType: { ...emptyString, patternP8: { ...p8 } },
    deductibleIndividual: { ...emptyNumber, patternP8: { ...p8 } },
    deductibleFamily: { ...emptyNumber, patternP8: { ...p8 } },
    oopMaxIndividual: { ...emptyNumber, patternP8: { ...p8 } },
    oopMaxFamily: { ...emptyNumber, patternP8: { ...p8 } },
    outDeductibleIndividual: { ...emptyNumber, patternP8: { ...p8 } },
    outDeductibleFamily: { ...emptyNumber, patternP8: { ...p8 } },
    outOopMaxIndividual: { ...emptyNumber, patternP8: { ...p8 } },
    outOopMaxFamily: { ...emptyNumber, patternP8: { ...p8 } },
    // S74.6 D1 — ACA-compliance fields (boolean + enum-as-string).
    // emptyBoolean shape uses null value + empty P-8 like emptyString/emptyNumber.
    isAcaCompliant: { value: null, patternP8: { ...p8 } } as PlanDocField<boolean | null>,
    acaComplianceBasis: { ...emptyString, patternP8: { ...p8 } },
  };
}
