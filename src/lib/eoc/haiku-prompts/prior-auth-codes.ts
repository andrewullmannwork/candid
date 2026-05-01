/**
 * EOC Section A — Prior Authorization Code Lists.
 * Per [[plans/findings/eoc_field_differential]] §1.2 A.
 */

import type { ExtractionMethod } from "../../parser/types";
import type { EOCSectionResult, PriorAuthCode, PriorAuthCodesData } from "../types";
import { callHaikuWithCache } from "./_shared";

const INSTRUCTIONS = `You are extracting Prior Authorization (PA) requirements from an Evidence of Coverage (EOC) document section. Return a single JSON object listing every billing code that requires PA, with criteria text per code.

## CRITICAL EXTRACTION RULES

1. **Verbatim source_excerpt**: For every code, include a verbatim quote (≤200 chars) from the EOC text where the code appears. NEVER fabricate or paraphrase.
2. **Code identification**: extract billing_code + billing_code_type. Valid types: CPT (5 digits, e.g., "99213"), HCPCS (letter + 4 digits, e.g., "J3490"), NDC (drug, e.g., "0002-1407-30"), REV (revenue, e.g., "0250"), DRG (e.g., "470").
3. **PA criteria**: free-form text describing when PA is required for this code (may be empty if just listed). Verbatim from EOC; do NOT summarize.
4. **DO NOT extract**: codes mentioned in glossary cross-references, footer legal disclaimers, definitions section, header marketing copy. Those go to source_section_hint='glossary_legalese_DO_NOT_EXTRACT' or 'header_DO_NOT_EXTRACT'.
5. **source_section_hint**: always 'prior_auth_codes' for codes from the actual PA list section.

## RESPONSE SCHEMA

{
  "codes": [
    {
      "billing_code": "99213",
      "billing_code_type": "CPT",
      "pa_criteria": "Required for all outpatient evaluation and management visits over 30 minutes" (or null),
      "source_excerpt": "verbatim ≤200 chars from EOC where this code+criteria appears",
      "source_section_hint": "prior_auth_codes",
      "haiku_confidence": 0.95
    },
    ...
  ]
}

## EXAMPLE

EOC text snippet:
"Section 4.2 Prior Authorization Required Codes
The following services require prior authorization from the plan:
- 99213 (Office visit, established patient, 15-29 min) — Required if visit exceeds 30 minutes
- 70553 (MRI brain w/o + w/ contrast) — Required for all outpatient imaging
- J3490 (Unclassified drugs) — Required for all unclassified injectables ≥$500"

Correct extraction:
{
  "codes": [
    {
      "billing_code": "99213",
      "billing_code_type": "CPT",
      "pa_criteria": "Required if visit exceeds 30 minutes",
      "source_excerpt": "99213 (Office visit, established patient, 15-29 min) — Required if visit exceeds 30 minutes",
      "source_section_hint": "prior_auth_codes",
      "haiku_confidence": 0.97
    },
    {
      "billing_code": "70553",
      "billing_code_type": "CPT",
      "pa_criteria": "Required for all outpatient imaging",
      "source_excerpt": "70553 (MRI brain w/o + w/ contrast) — Required for all outpatient imaging",
      "source_section_hint": "prior_auth_codes",
      "haiku_confidence": 0.97
    },
    {
      "billing_code": "J3490",
      "billing_code_type": "HCPCS",
      "pa_criteria": "Required for all unclassified injectables ≥$500",
      "source_excerpt": "J3490 (Unclassified drugs) — Required for all unclassified injectables ≥$500",
      "source_section_hint": "prior_auth_codes",
      "haiku_confidence": 0.96
    }
  ]
}

## NOW EXTRACT FROM THIS DOCUMENT SECTION:`;

interface RawResponse {
  codes?: Array<Record<string, unknown>>;
}

export async function extractPriorAuthCodes(
  sectionText: string,
  sectionRange: { start: number; end: number },
  extractionMethod: ExtractionMethod,
): Promise<EOCSectionResult<PriorAuthCodesData>> {
  const result = await callHaikuWithCache<RawResponse>({
    systemPrompt: INSTRUCTIONS,
    userContent: sectionText,
    sectionLabel: "prior_auth_codes",
  });

  const validTypes = new Set(["CPT", "HCPCS", "NDC", "REV", "DRG"]);
  const codes: PriorAuthCode[] = (result.data.codes ?? [])
    .map((raw): PriorAuthCode | null => {
      const billingCode = typeof raw.billing_code === "string" ? raw.billing_code.trim() : null;
      const billingCodeTypeRaw = typeof raw.billing_code_type === "string" ? raw.billing_code_type.trim().toUpperCase() : null;
      if (!billingCode || !billingCodeTypeRaw || !validTypes.has(billingCodeTypeRaw)) return null;
      const sourceExcerpt = typeof raw.source_excerpt === "string" ? raw.source_excerpt.slice(0, 200) : "";
      return {
        billing_code: billingCode,
        billing_code_type: billingCodeTypeRaw as PriorAuthCode["billing_code_type"],
        pa_criteria: typeof raw.pa_criteria === "string" ? raw.pa_criteria : null,
        source_excerpt: sourceExcerpt,
        source_excerpt_verified: "not_found", // verifier overrides post-extraction
        source_excerpt_extraction_method: extractionMethod,
        source_section_hint: "prior_auth_codes",
        source_section_verified: false, // verifier overrides
        haiku_confidence: typeof raw.haiku_confidence === "number" ? raw.haiku_confidence : undefined,
      };
    })
    .filter((c): c is PriorAuthCode => c !== null);

  return {
    section_type: "prior_auth_codes",
    section_range: sectionRange,
    data: { codes },
    haiku_input_tokens: result.inputTokens,
    haiku_output_tokens: result.outputTokens,
    haiku_cost_usd: result.costUsd,
    warnings: result.warnings,
  };
}
