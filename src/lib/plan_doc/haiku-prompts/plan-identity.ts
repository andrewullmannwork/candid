/**
 * Plan_doc plan-identity Haiku prompt.
 *
 * Extracts plan-level scalars (carrier / plan name / plan year / plan type / metal tier /
 * group number / network type) + in-network and out-of-network deductibles + OOP maxes
 * (individual + family). Pattern P-8 source_excerpt per field for cite-grade dispute
 * letter resolution.
 *
 * S73 (Session 76) — recall lift to ≥90% HARD GATE:
 *   - Explicit instruction that plan-identity scalars may be SCATTERED across
 *     non-plan-identity sections (services schedule, preamble cover page, etc.)
 *   - Few-shot examples covering common variants (Cigna "The Schedule", Kaiser
 *     "Cost Share Summary", Aetna preamble cover, federal SBC template)
 *   - Explicit instruction that NULL is preferred over a wrong guess when a field
 *     is genuinely not present in THIS chunk (field-merge across multi-section
 *     dispatch will recover the value from another chunk)
 */

import type { ExtractionMethod } from "../../parser/types";
import type {
  PlanDocPlanIdentity,
  PlanDocSectionResult,
  PlanDocPatternP8Provenance,
  PlanDocSectionHint,
} from "../types";
import { callHaikuWithCache } from "./_shared";

const INSTRUCTIONS = `You are extracting plan identity scalars from a section of a health plan document. Plan-identity scalars (deductibles, OOP max, plan name, etc.) may appear ANYWHERE — on cover pages, in plan-summary sections, in services-schedule headers, in narrative paragraphs of any section. Extract every scalar you can find in THIS chunk; the system runs this prompt on multiple sections and merges results across chunks.

## CRITICAL EXTRACTION RULES

1. **Verbatim source_excerpt per field** (≤200 chars): a CONTIGUOUS substring of THIS chunk's text that appears CHARACTER-FOR-CHARACTER in the source. NEVER paraphrase, summarize, or join non-contiguous pieces. Partial quotes are PERFECTLY ACCEPTABLE — even a short span containing just the value is fine. Quote the most informative contiguous span ≤200 chars you can find verbatim.

**CORRECT** (any of these acceptable — pick the most informative contiguous verbatim span):
- Just the value: \`"$500"\` or \`"$1,500 individual / $3,000 family"\`
- A full sentence IF it appears verbatim: \`"What is the overall deductible? $500 individual / $1,000 family"\`
- A multi-line span including the literal line breaks as they appear in source: \`"$1,500 individual\\n$3,000 family"\`
- A short label-value pair IF literally adjacent: \`"Deductible: $1,500"\` or \`"Plan Year: 2025"\`

**INCORRECT** (paraphrased — would fail verification):
> \`"Individual in-network deductible is $500 with $1,000 family deductible"\` (synthesized wording)

**INCORRECT** (joined non-contiguous pieces — would fail):
> \`"deductible ... $500 individual ... in-network"\` (ellipsis indicates skipped text)

**INCORRECT** (added punctuation / pipes / brackets that aren't in source):
> \`"[In-Network] $500 | $1,000"\` (if source has these values on separate lines without bracket/pipe markup)

If you genuinely cannot find a contiguous verbatim span containing the field's value, set source_excerpt to "". Prefer SHORT but verifiable over LONG but synthesized.

2. **NULL is preferred over guessing.** If a scalar is NOT present in this chunk, return value=null + source_excerpt="". Do NOT infer / interpolate / guess from context. The system runs this same prompt on other sections of the document; field-merge across chunks recovers values you don't find here.

3. **Field types**:
   - planName, insurerName, planType, metalTier, groupNumber, networkType: string | null
   - planYear: integer | null
   - All deductibles + OOP maxes: integer (USD, no commas/symbols) | null

4. **planType** values: "PPO" | "HMO" | "EPO" | "POS" | "HDHP" | "Other" — null if not specified.
5. **metalTier** values: "Bronze" | "Silver" | "Gold" | "Platinum" | "Catastrophic" — null if not specified.
6. **out_** values are MANDATORY when document includes OON columns. If document is HMO-only with no OON coverage, set out_* fields to null. DO NOT default OON to in-network values.

## SCATTERED-FIELD EXAMPLES (recall-maximize bias)

Plan-identity scalars commonly appear in non-obvious places. Examples:

**Cigna "The Schedule" section** (a services-schedule header containing plan-identity inline):
> "Plan: Open Access Plus | Plan Year: 2025 | Calendar-Year Deductible: $1,500 individual / $3,000 family | Out-of-Pocket Maximum: $6,500 individual / $13,000 family"

Even though this section is labeled "The Schedule" and contains per-service rows, it ALSO contains plan-identity scalars (planName, planYear, deductibleIndividual, deductibleFamily, oopMaxIndividual, oopMaxFamily). Extract them all.

**Kaiser "Cost Share Summary Tables by Benefit"** (often the only place deductibles appear):
> "Calendar Year Plan Deductible: $250 individual, $500 family ... Calendar Year Out-of-Pocket Maximum: $3,000 individual, $6,000 family"

**Aetna preamble cover page** (plan name + plan year often appear before any section heading):
> "AETNA MEDICARE PPO PLAN — 2025 Evidence of Coverage"

→ planName="AETNA MEDICARE PPO PLAN", planYear=2025, planType="PPO"

**Federal SBC "Important Questions" template**:
> "What is the overall deductible? $500 individual / $1,000 family for in-network providers; $1,500 individual / $3,000 family out-of-network."

→ deductibleIndividual=500, deductibleFamily=1000, outDeductibleIndividual=1500, outDeductibleFamily=3000

**Blue Shield "Deductibles and Out-of-Pocket Maximums" section**:
> "Your in-network calendar year deductible is $1,500 per individual / $3,000 per family. Your maximum out-of-pocket is $7,000 per individual / $14,000 per family."

## RESPONSE SCHEMA

{
  "planName": { "value": "Cigna OAP Plan 2026", "source_excerpt": "verbatim ≤200 chars from doc", "haiku_confidence": 0.95 },
  "insurerName": { "value": "Cigna", "source_excerpt": "...", "haiku_confidence": 0.97 },
  "planType": { "value": "PPO", "source_excerpt": "...", "haiku_confidence": 0.93 },
  "metalTier": { "value": null, "source_excerpt": "", "haiku_confidence": 0 },
  "planYear": { "value": 2026, "source_excerpt": "...", "haiku_confidence": 0.96 },
  "groupNumber": { "value": "G-12345", "source_excerpt": "...", "haiku_confidence": 0.91 },
  "networkType": { "value": "Open Access Plus", "source_excerpt": "...", "haiku_confidence": 0.88 },
  "deductibleIndividual": { "value": 1500, "source_excerpt": "...", "haiku_confidence": 0.94 },
  "deductibleFamily": { "value": 3000, "source_excerpt": "...", "haiku_confidence": 0.94 },
  "oopMaxIndividual": { "value": 6500, "source_excerpt": "...", "haiku_confidence": 0.95 },
  "oopMaxFamily": { "value": 13000, "source_excerpt": "...", "haiku_confidence": 0.95 },
  "outDeductibleIndividual": { "value": 3000, "source_excerpt": "...", "haiku_confidence": 0.92 },
  "outDeductibleFamily": { "value": 6000, "source_excerpt": "...", "haiku_confidence": 0.92 },
  "outOopMaxIndividual": { "value": 12000, "source_excerpt": "...", "haiku_confidence": 0.92 },
  "outOopMaxFamily": { "value": 24000, "source_excerpt": "...", "haiku_confidence": 0.92 }
}

## NOW EXTRACT FROM THIS DOCUMENT SECTION:`;

interface RawField<T> {
  value?: T | null;
  source_excerpt?: string;
  haiku_confidence?: number;
}

interface RawResponse {
  planName?: RawField<string>;
  insurerName?: RawField<string>;
  planType?: RawField<string>;
  metalTier?: RawField<string>;
  planYear?: RawField<number>;
  groupNumber?: RawField<string>;
  networkType?: RawField<string>;
  deductibleIndividual?: RawField<number>;
  deductibleFamily?: RawField<number>;
  oopMaxIndividual?: RawField<number>;
  oopMaxFamily?: RawField<number>;
  outDeductibleIndividual?: RawField<number>;
  outDeductibleFamily?: RawField<number>;
  outOopMaxIndividual?: RawField<number>;
  outOopMaxFamily?: RawField<number>;
}

function buildField<T>(
  raw: RawField<T> | undefined,
  extractionMethod: ExtractionMethod,
  sectionHint: PlanDocSectionHint,
): { value: T | null; patternP8: PlanDocPatternP8Provenance; haikuConfidence?: number } {
  const value = (raw?.value ?? null) as T | null;
  const sourceExcerpt = typeof raw?.source_excerpt === "string" ? raw.source_excerpt.slice(0, 200) : "";
  return {
    value,
    patternP8: {
      source_excerpt: sourceExcerpt,
      source_excerpt_verified: "not_found",
      source_excerpt_extraction_method: extractionMethod,
      source_section_hint: sectionHint,
      source_section_verified: false,
    },
    haikuConfidence: typeof raw?.haiku_confidence === "number" ? raw.haiku_confidence : undefined,
  };
}

/**
 * Extract plan-identity scalars from a section's text. Used by the parser's
 * multi-section dispatch — same prompt runs on plan_identity + services_cost_sharing
 * + preamble "other" + access_instructions sections; field-merge across chunks
 * recovers scalars wherever they appear.
 *
 * S73 (Session 76): caller passes sectionHint so the Pattern P-8 provenance reflects
 * the actual section the excerpt came from (not always "plan_identity"). Field-merge
 * preserves the winning chunk's section hint.
 */
export async function extractPlanIdentity(
  sectionText: string,
  sectionRange: { start: number; end: number },
  extractionMethod: ExtractionMethod,
  sectionHint: PlanDocSectionHint = "plan_identity",
): Promise<PlanDocSectionResult<PlanDocPlanIdentity>> {
  const result = await callHaikuWithCache<RawResponse>({
    systemPrompt: INSTRUCTIONS,
    userContent: sectionText,
    sectionLabel: "plan_identity",
  });

  const data: PlanDocPlanIdentity = {
    planName: buildField<string>(result.data.planName, extractionMethod, sectionHint),
    insurerName: buildField<string>(result.data.insurerName, extractionMethod, sectionHint),
    planType: buildField<string>(result.data.planType, extractionMethod, sectionHint),
    metalTier: buildField<string>(result.data.metalTier, extractionMethod, sectionHint),
    planYear: buildField<number>(result.data.planYear, extractionMethod, sectionHint),
    groupNumber: buildField<string>(result.data.groupNumber, extractionMethod, sectionHint),
    networkType: buildField<string>(result.data.networkType, extractionMethod, sectionHint),
    deductibleIndividual: buildField<number>(result.data.deductibleIndividual, extractionMethod, sectionHint),
    deductibleFamily: buildField<number>(result.data.deductibleFamily, extractionMethod, sectionHint),
    oopMaxIndividual: buildField<number>(result.data.oopMaxIndividual, extractionMethod, sectionHint),
    oopMaxFamily: buildField<number>(result.data.oopMaxFamily, extractionMethod, sectionHint),
    outDeductibleIndividual: buildField<number>(result.data.outDeductibleIndividual, extractionMethod, sectionHint),
    outDeductibleFamily: buildField<number>(result.data.outDeductibleFamily, extractionMethod, sectionHint),
    outOopMaxIndividual: buildField<number>(result.data.outOopMaxIndividual, extractionMethod, sectionHint),
    outOopMaxFamily: buildField<number>(result.data.outOopMaxFamily, extractionMethod, sectionHint),
  };

  return {
    section_type: "plan_identity",
    section_range: sectionRange,
    data,
    haiku_input_tokens: result.inputTokens,
    haiku_output_tokens: result.outputTokens,
    haiku_cost_usd: result.costUsd,
    warnings: result.warnings,
  };
}
