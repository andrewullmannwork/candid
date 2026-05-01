/**
 * EOC Section F — Eligibility + Effective Date Rules.
 * Per [[plans/findings/eoc_field_differential]] §1.2 F.
 */

import type { ExtractionMethod } from "../../parser/types";
import type { EligibilityRulesData, EOCSectionResult } from "../types";
import { callHaikuWithCache } from "./_shared";

const INSTRUCTIONS = `You are extracting Eligibility + Effective Date Rules from an Evidence of Coverage (EOC) document section. Return a single JSON object.

## CRITICAL EXTRACTION RULES

1. **Verbatim source_excerpt** (≤200 chars).
2. **effective_date_rule**: free-form text describing when coverage starts (e.g., "1st of month following enrollment", "date of hire", "30 days after enrollment").
3. **dependent_age_limit**: integer max age for dependent coverage (typically 26 under ACA). Use null if not specified.
4. **cobra_eligible**: true if the plan offers COBRA continuation; false if explicitly not (rare); null if unstated.
5. **cobra_max_months**: integer max months of COBRA coverage. Typical values: 18 (standard), 29 (disability), 36 (specific qualifying events). Use null if unstated.
6. **special_enrollment_events**: array of qualifying life events (e.g., ["marriage", "birth", "adoption", "loss_of_other_coverage", "moving_to_new_service_area", "loss_of_dependent_status"]). Use snake_case canonical names; empty array if not enumerated.
7. **full_text**: verbatim full eligibility section text.
8. **source_section_hint**: always 'eligibility_rules'.

## RESPONSE SCHEMA

{
  "effective_date_rule": "First day of the month following enrollment",
  "dependent_age_limit": 26,
  "cobra_eligible": true,
  "cobra_max_months": 18,
  "special_enrollment_events": ["marriage", "birth", "adoption", "loss_of_other_coverage"],
  "full_text": "verbatim full eligibility section text",
  "source_excerpt": "verbatim ≤200 chars",
  "source_section_hint": "eligibility_rules",
  "haiku_confidence": 0.9
}

## NOW EXTRACT FROM THIS DOCUMENT SECTION:`;

interface RawResponse {
  effective_date_rule?: string;
  dependent_age_limit?: number | null;
  cobra_eligible?: boolean | null;
  cobra_max_months?: number | null;
  special_enrollment_events?: string[];
  full_text?: string;
  source_excerpt?: string;
  haiku_confidence?: number;
}

export async function extractEligibilityRules(
  sectionText: string,
  sectionRange: { start: number; end: number },
  extractionMethod: ExtractionMethod,
): Promise<EOCSectionResult<EligibilityRulesData>> {
  const result = await callHaikuWithCache<RawResponse>({
    systemPrompt: INSTRUCTIONS,
    userContent: sectionText,
    sectionLabel: "eligibility_rules",
  });

  const events = Array.isArray(result.data.special_enrollment_events)
    ? result.data.special_enrollment_events.filter((e): e is string => typeof e === "string")
    : [];

  const data: EligibilityRulesData = {
    effective_date_rule: typeof result.data.effective_date_rule === "string" ? result.data.effective_date_rule : "",
    dependent_age_limit: typeof result.data.dependent_age_limit === "number" ? result.data.dependent_age_limit : null,
    cobra_eligible: typeof result.data.cobra_eligible === "boolean" ? result.data.cobra_eligible : null,
    cobra_max_months: typeof result.data.cobra_max_months === "number" ? result.data.cobra_max_months : null,
    special_enrollment_events: events,
    full_text: typeof result.data.full_text === "string" ? result.data.full_text : "",
    source_excerpt: typeof result.data.source_excerpt === "string" ? result.data.source_excerpt.slice(0, 200) : "",
    source_excerpt_verified: "not_found",
    source_excerpt_extraction_method: extractionMethod,
    source_section_hint: "eligibility_rules",
    source_section_verified: false,
    haiku_confidence: typeof result.data.haiku_confidence === "number" ? result.data.haiku_confidence : undefined,
  };

  return {
    section_type: "eligibility_rules",
    section_range: sectionRange,
    data,
    haiku_input_tokens: result.inputTokens,
    haiku_output_tokens: result.outputTokens,
    haiku_cost_usd: result.costUsd,
    warnings: result.warnings,
  };
}
