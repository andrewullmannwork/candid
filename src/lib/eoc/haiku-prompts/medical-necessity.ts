/**
 * EOC Section B — Medical Necessity Criteria.
 * Per [[plans/findings/eoc_field_differential]] §1.2 B.
 *
 * Note: ICD-10 diagnosis codes referenced here are stored as `diagnosis_qualifiers`
 * (string array) on the criterion row — they do NOT enter `concept_admin_review_queue`
 * per Q-DR-3.1A-B-2 LOCK (queue is for billing codes only, not diagnosis codes).
 */

import type { ExtractionMethod } from "../../parser/types";
import type { EOCSectionResult, MedicalNecessityCriterion, MedicalNecessityData } from "../types";
import { callHaikuWithCache } from "./_shared";

const INSTRUCTIONS = `You are extracting Medical Necessity Criteria from an Evidence of Coverage (EOC) document section. Return a single JSON object listing the criteria per service.

## CRITICAL EXTRACTION RULES

1. **Verbatim source_excerpt** per criterion (≤200 chars).
2. **service_slug_hint**: best-guess match to a known service slug (e.g., "bariatric_surgery", "pcp_visit", "specialist_visit", "physical_therapy", "mri_brain"). Set null if uncertain.
3. **criteria_text**: verbatim full criteria description (NOT summarized). May be multi-sentence.
4. **diagnosis_qualifiers**: extract any ICD-10 diagnosis codes referenced in the criteria (e.g., "E66.01" for obesity). Empty array if none. These codes are NOT extracted as billing codes — they are conditions of coverage.
5. **DO NOT extract**: criteria from glossary cross-references, header marketing, or footer disclaimers.
6. **source_section_hint**: always 'medical_necessity'.

## RESPONSE SCHEMA

{
  "criteria": [
    {
      "service_slug_hint": "bariatric_surgery" (or null),
      "criteria_text": "Bariatric surgery is medically necessary when patient has BMI ≥40 OR BMI ≥35 with documented comorbidity (E66.01, E11.9, I10) AND has completed 6 months of supervised weight loss program",
      "diagnosis_qualifiers": ["E66.01", "E11.9", "I10"],
      "source_excerpt": "verbatim ≤200 chars",
      "source_section_hint": "medical_necessity",
      "haiku_confidence": 0.93
    }
  ]
}

## EXAMPLE

EOC text snippet:
"Bariatric Surgery — Coverage Criteria
Bariatric surgery is medically necessary when the member meets ALL of the following:
1. BMI ≥40, OR BMI ≥35 with at least one documented comorbidity (Type 2 diabetes E11.9, hypertension I10, obstructive sleep apnea G47.33, or osteoarthritis M19.91)
2. Documentation of 6 consecutive months of supervised weight loss program within the past 24 months
3. Psychological evaluation confirming readiness for surgery

Coverage requires prior authorization."

Correct extraction:
{
  "criteria": [
    {
      "service_slug_hint": "bariatric_surgery",
      "criteria_text": "Bariatric surgery is medically necessary when the member meets ALL of the following: 1. BMI ≥40, OR BMI ≥35 with at least one documented comorbidity (Type 2 diabetes E11.9, hypertension I10, obstructive sleep apnea G47.33, or osteoarthritis M19.91) 2. Documentation of 6 consecutive months of supervised weight loss program within the past 24 months 3. Psychological evaluation confirming readiness for surgery",
      "diagnosis_qualifiers": ["E11.9", "I10", "G47.33", "M19.91"],
      "source_excerpt": "Bariatric surgery is medically necessary when the member meets ALL of the following: 1. BMI ≥40, OR BMI ≥35 with at least one documented comorbidity",
      "source_section_hint": "medical_necessity",
      "haiku_confidence": 0.95
    }
  ]
}

## NOW EXTRACT FROM THIS DOCUMENT SECTION:`;

interface RawResponse {
  criteria?: Array<Record<string, unknown>>;
}

export async function extractMedicalNecessity(
  sectionText: string,
  sectionRange: { start: number; end: number },
  extractionMethod: ExtractionMethod,
): Promise<EOCSectionResult<MedicalNecessityData>> {
  const result = await callHaikuWithCache<RawResponse>({
    systemPrompt: INSTRUCTIONS,
    userContent: sectionText,
    sectionLabel: "medical_necessity",
  });

  const criteria: MedicalNecessityCriterion[] = (result.data.criteria ?? [])
    .map((raw): MedicalNecessityCriterion | null => {
      const criteriaText = typeof raw.criteria_text === "string" ? raw.criteria_text : null;
      if (!criteriaText) return null;
      const sourceExcerpt = typeof raw.source_excerpt === "string" ? raw.source_excerpt.slice(0, 200) : "";
      const dxQualifiers = Array.isArray(raw.diagnosis_qualifiers)
        ? raw.diagnosis_qualifiers.filter((d): d is string => typeof d === "string")
        : [];
      return {
        service_slug_hint: typeof raw.service_slug_hint === "string" ? raw.service_slug_hint : null,
        criteria_text: criteriaText,
        diagnosis_qualifiers: dxQualifiers,
        source_excerpt: sourceExcerpt,
        source_excerpt_verified: "not_found",
        source_excerpt_extraction_method: extractionMethod,
        source_section_hint: "medical_necessity",
        source_section_verified: false,
        haiku_confidence: typeof raw.haiku_confidence === "number" ? raw.haiku_confidence : undefined,
      };
    })
    .filter((c): c is MedicalNecessityCriterion => c !== null);

  return {
    section_type: "medical_necessity",
    section_range: sectionRange,
    data: { criteria },
    haiku_input_tokens: result.inputTokens,
    haiku_output_tokens: result.outputTokens,
    haiku_cost_usd: result.costUsd,
    warnings: result.warnings,
  };
}
