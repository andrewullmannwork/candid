/**
 * EOC Section D — Coordination of Benefits Rules.
 * Per [[plans/findings/eoc_field_differential]] §1.2 D.
 */

import type { ExtractionMethod } from "../../parser/types";
import type { COBRulesData, EOCSectionResult } from "../types";
import { callHaikuWithCache } from "./_shared";

const INSTRUCTIONS = `You are extracting Coordination of Benefits (COB) rules from an Evidence of Coverage (EOC) document section. Return a single JSON object describing how this plan determines primary vs secondary coverage.

## CRITICAL EXTRACTION RULES

1. **Verbatim source_excerpt** (≤200 chars). MUST be a CHARACTER-FOR-CHARACTER substring of the document section text — NEVER paraphrase, summarize, or normalize whitespace/punctuation. If you cannot find a verbatim ≤200-char span that supports the field, set source_excerpt to "" (empty) — the verifier marks empty as 'not_found' (graceful degradation), which is the correct outcome rather than a wrong excerpt.
2. **primary_determination_method**: which rule decides primary vs secondary insurer? Valid values: 'birthday_rule' (parent with earlier birthday in calendar year is primary for dependents), 'employer_first' (employer plan primary over spouse's plan), 'spouse_first', 'longer_continuous_coverage' (longer-covered plan is primary), 'other' (free-form), or null if not specified.
3. **calculation_method**: how does the secondary plan calculate benefits? Valid values: 'non_duplication' (secondary pays only the difference between primary's payment and what secondary would have paid alone), 'maintenance_of_benefits' (secondary maintains 100% benefit ceiling minus primary's payment), 'coverage_as_primary' (secondary calculates as if primary), 'other', or null.
4. **erisa_preempted**: true if EOC explicitly states the plan is governed by ERISA (federal law preempts state COB rules); false if explicitly state-governed; null if unstated.
5. **full_text**: verbatim full COB rules text (drives dispute-letter citation evidence).
6. **source_section_hint**: always 'cob_rules'.

## RESPONSE SCHEMA

{
  "primary_determination_method": "birthday_rule",
  "calculation_method": "non_duplication",
  "erisa_preempted": true,
  "full_text": "verbatim full COB section text",
  "source_excerpt": "verbatim ≤200 chars",
  "source_section_hint": "cob_rules",
  "haiku_confidence": 0.91
}

## OUTPUT FAILURE MODE

If you cannot quote verbatim with high confidence, return:
  "source_excerpt": ""
  "haiku_confidence": (lower value reflecting uncertainty)
The verifier marks empty excerpts as 'not_found' — graceful degradation to display-only rendering. This is preferred over a wrong excerpt that will fail verification.

## CORRECT vs INCORRECT EXCERPT EXAMPLES

Source text in section: "When you have other coverage, this plan acts as the secondary payer for services covered by both plans, using the non-duplication of benefits method."

❌ INCORRECT (paraphrased): "Plan is secondary if member has other coverage"
Why wrong: not a substring of the document.

❌ INCORRECT (whitespace adjusted): "When you have other coverage this plan acts as secondary payer using non-duplication method"
Why wrong: dropped commas + dropped words ("the", "for services covered by both plans", "of benefits").

❌ INCORRECT (semantically right but from wrong location): "Eligibility: To enroll dependents, the subscriber must elect within 30 days"
Why wrong: from the eligibility section, not the cob_rules narrative.

✅ CORRECT (verbatim substring of source): "When you have other coverage, this plan acts as the secondary payer for services covered by both plans"

## NOW EXTRACT FROM THIS DOCUMENT SECTION:`;

interface RawResponse {
  primary_determination_method?: string | null;
  calculation_method?: string | null;
  erisa_preempted?: boolean | null;
  full_text?: string;
  source_excerpt?: string;
  haiku_confidence?: number;
}

export async function extractCOBRules(
  sectionText: string,
  sectionRange: { start: number; end: number },
  extractionMethod: ExtractionMethod,
): Promise<EOCSectionResult<COBRulesData>> {
  const result = await callHaikuWithCache<RawResponse>({
    systemPrompt: INSTRUCTIONS,
    userContent: sectionText,
    sectionLabel: "cob_rules",
  });

  const validPrimary = new Set(["birthday_rule", "employer_first", "spouse_first", "longer_continuous_coverage", "other"]);
  const validCalc = new Set(["non_duplication", "maintenance_of_benefits", "coverage_as_primary", "other"]);

  const data: COBRulesData = {
    primary_determination_method:
      typeof result.data.primary_determination_method === "string" && validPrimary.has(result.data.primary_determination_method)
        ? (result.data.primary_determination_method as COBRulesData["primary_determination_method"])
        : null,
    calculation_method:
      typeof result.data.calculation_method === "string" && validCalc.has(result.data.calculation_method)
        ? (result.data.calculation_method as COBRulesData["calculation_method"])
        : null,
    erisa_preempted: typeof result.data.erisa_preempted === "boolean" ? result.data.erisa_preempted : null,
    full_text: typeof result.data.full_text === "string" ? result.data.full_text : "",
    source_excerpt: typeof result.data.source_excerpt === "string" ? result.data.source_excerpt.slice(0, 200) : "",
    source_excerpt_verified: "not_found",
    source_excerpt_extraction_method: extractionMethod,
    source_section_hint: "cob_rules",
    source_section_verified: false,
    haiku_confidence: typeof result.data.haiku_confidence === "number" ? result.data.haiku_confidence : undefined,
  };

  return {
    section_type: "cob_rules",
    section_range: sectionRange,
    data,
    haiku_input_tokens: result.inputTokens,
    haiku_output_tokens: result.outputTokens,
    haiku_cost_usd: result.costUsd,
    warnings: result.warnings,
  };
}
