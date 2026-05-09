/**
 * Plan_doc plan-identity Haiku prompt.
 *
 * Extracts plan-level scalars (carrier / plan name / plan year / plan type / metal tier /
 * group number / network type) + in-network and out-of-network deductibles + OOP maxes
 * (individual + family). Pattern P-8 source_excerpt per field for cite-grade dispute
 * letter resolution.
 */

import type { ExtractionMethod } from "../../parser/types";
import type {
  PlanDocPlanIdentity,
  PlanDocSectionResult,
  PlanDocPatternP8Provenance,
} from "../types";
import { callHaikuWithCache } from "./_shared";

const INSTRUCTIONS = `You are extracting plan identity from a Plan Document section. Return a single JSON object with all fields.

## CRITICAL EXTRACTION RULES

1. **Verbatim source_excerpt per field** (≤200 chars): include a CHARACTER-FOR-CHARACTER substring of the document section text where this field's value appears. NEVER paraphrase, summarize, or normalize whitespace/punctuation. If you cannot find a verbatim ≤200-char span, set source_excerpt to "" — verifier marks empty as 'not_found' (graceful degradation), preferred over a wrong excerpt.

2. **Field types**:
   - planName, insurerName, planType, metalTier, groupNumber, networkType: string | null
   - planYear: integer | null
   - All deductibles + OOP maxes: integer (USD, no commas/symbols) | null

3. **planType** values: "PPO" | "HMO" | "EPO" | "POS" | "HDHP" | "Other" — null if not specified.
4. **metalTier** values: "Bronze" | "Silver" | "Gold" | "Platinum" | "Catastrophic" — null if not specified.
5. **out_** values are MANDATORY when document includes OON columns. If document is HMO-only with no OON coverage, set out_* fields to null. DO NOT default OON to in-network values.

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
): { value: T | null; patternP8: PlanDocPatternP8Provenance; haikuConfidence?: number } {
  const value = (raw?.value ?? null) as T | null;
  const sourceExcerpt = typeof raw?.source_excerpt === "string" ? raw.source_excerpt.slice(0, 200) : "";
  return {
    value,
    patternP8: {
      source_excerpt: sourceExcerpt,
      source_excerpt_verified: "not_found",
      source_excerpt_extraction_method: extractionMethod,
      source_section_hint: "plan_identity",
      source_section_verified: false,
    },
    haikuConfidence: typeof raw?.haiku_confidence === "number" ? raw.haiku_confidence : undefined,
  };
}

export async function extractPlanIdentity(
  sectionText: string,
  sectionRange: { start: number; end: number },
  extractionMethod: ExtractionMethod,
): Promise<PlanDocSectionResult<PlanDocPlanIdentity>> {
  const result = await callHaikuWithCache<RawResponse>({
    systemPrompt: INSTRUCTIONS,
    userContent: sectionText,
    sectionLabel: "plan_identity",
  });

  const data: PlanDocPlanIdentity = {
    planName: buildField<string>(result.data.planName, extractionMethod),
    insurerName: buildField<string>(result.data.insurerName, extractionMethod),
    planType: buildField<string>(result.data.planType, extractionMethod),
    metalTier: buildField<string>(result.data.metalTier, extractionMethod),
    planYear: buildField<number>(result.data.planYear, extractionMethod),
    groupNumber: buildField<string>(result.data.groupNumber, extractionMethod),
    networkType: buildField<string>(result.data.networkType, extractionMethod),
    deductibleIndividual: buildField<number>(result.data.deductibleIndividual, extractionMethod),
    deductibleFamily: buildField<number>(result.data.deductibleFamily, extractionMethod),
    oopMaxIndividual: buildField<number>(result.data.oopMaxIndividual, extractionMethod),
    oopMaxFamily: buildField<number>(result.data.oopMaxFamily, extractionMethod),
    outDeductibleIndividual: buildField<number>(result.data.outDeductibleIndividual, extractionMethod),
    outDeductibleFamily: buildField<number>(result.data.outDeductibleFamily, extractionMethod),
    outOopMaxIndividual: buildField<number>(result.data.outOopMaxIndividual, extractionMethod),
    outOopMaxFamily: buildField<number>(result.data.outOopMaxFamily, extractionMethod),
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
