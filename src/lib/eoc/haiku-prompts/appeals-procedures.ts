/**
 * EOC Section C — Internal/External Appeals Procedures.
 * Per [[plans/findings/eoc_field_differential]] §1.2 C.
 *
 * Single block (not array) — most EOCs have one canonical appeals procedure.
 */

import type { ExtractionMethod } from "../../parser/types";
import type { AppealsProceduresData, EOCSectionResult } from "../types";
import { callHaikuWithCache } from "./_shared";

const INSTRUCTIONS = `You are extracting Appeals Procedures from an Evidence of Coverage (EOC) document section. Return a single JSON object describing the appeals process.

## CRITICAL EXTRACTION RULES

1. **Verbatim source_excerpt** (≤200 chars) capturing the most-citation-worthy excerpt — typically the timing window line. MUST be a CHARACTER-FOR-CHARACTER substring of the document section text — NEVER paraphrase, summarize, or normalize whitespace/punctuation. If you cannot find a verbatim ≤200-char span that supports the field, set source_excerpt to "" (empty) — the verifier marks empty as 'not_found' (graceful degradation), which is the correct outcome rather than a wrong excerpt.
2. **Numeric timing windows**: extract days/hours as integers when explicitly stated. Use null when not specified.
3. **filing_methods**: array of valid methods. Use canonical strings: 'mail', 'fax', 'online_portal', 'phone'.
4. **full_text**: verbatim full appeals procedure text (may be long; this drives dispute-letter citation evidence). Do NOT summarize.
5. **iro_assignment_method**: free-form text describing how IRO is selected (e.g., "by the Department of Insurance" or "from a panel maintained by the plan"). Null if not stated.
6. **state_doi_complaint_text**: verbatim instructions for filing a state Department of Insurance complaint. Null if not in section.
7. **source_section_hint**: always 'appeals_procedures'.

## RESPONSE SCHEMA

{
  "internal_timing_days": 30,
  "internal_urgent_timing_hours": 72,
  "external_timing_days": 60,
  "iro_assignment_method": "Independent Review Organization assigned by the Department of Managed Health Care",
  "filing_methods": ["mail", "fax", "online_portal"],
  "state_doi_complaint_text": "If you have questions or concerns about your appeal, contact the California Department of Managed Health Care at 1-888-466-2219",
  "full_text": "verbatim full appeals procedure text from the EOC",
  "source_excerpt": "verbatim ≤200 chars (typically the standard internal review timing line)",
  "source_section_hint": "appeals_procedures",
  "haiku_confidence": 0.92
}

## OUTPUT FAILURE MODE

If you cannot quote verbatim with high confidence, return:
  "source_excerpt": ""
  "haiku_confidence": (lower value reflecting uncertainty)
The verifier marks empty excerpts as 'not_found' — graceful degradation to display-only rendering. This is preferred over a wrong excerpt that will fail verification.

## CORRECT vs INCORRECT EXCERPT EXAMPLES

Source text in section: "You must file your internal appeal within 30 days of the denial notice. Urgent appeals must be filed within 72 hours."

❌ INCORRECT (paraphrased): "Appeals deadline is 30 days, urgent 72 hours"
Why wrong: not a substring of the document.

❌ INCORRECT (whitespace adjusted): "You must file appeal within 30 days of denial. Urgent within 72 hours."
Why wrong: dropped words ("internal", "the", "notice", "appeals", "be filed") — not exact-match.

❌ INCORRECT (semantically right but from wrong location): "Appeal means a formal request to reconsider a coverage decision"
Why wrong: from the definitions section, not the appeals_procedures process narrative.

✅ CORRECT (verbatim substring of source): "You must file your internal appeal within 30 days of the denial notice"

## NOW EXTRACT FROM THIS DOCUMENT SECTION:`;

interface RawResponse {
  internal_timing_days?: number | null;
  internal_urgent_timing_hours?: number | null;
  external_timing_days?: number | null;
  iro_assignment_method?: string | null;
  filing_methods?: string[];
  state_doi_complaint_text?: string | null;
  full_text?: string;
  source_excerpt?: string;
  haiku_confidence?: number;
}

export async function extractAppealsProcedures(
  sectionText: string,
  sectionRange: { start: number; end: number },
  extractionMethod: ExtractionMethod,
): Promise<EOCSectionResult<AppealsProceduresData>> {
  const result = await callHaikuWithCache<RawResponse>({
    systemPrompt: INSTRUCTIONS,
    userContent: sectionText,
    sectionLabel: "appeals_procedures",
  });

  const validMethods = new Set(["mail", "fax", "online_portal", "phone"]);
  const filingMethods = Array.isArray(result.data.filing_methods)
    ? result.data.filing_methods.filter((m): m is string => typeof m === "string" && validMethods.has(m))
    : [];

  const data: AppealsProceduresData = {
    internal_timing_days: typeof result.data.internal_timing_days === "number" ? result.data.internal_timing_days : null,
    internal_urgent_timing_hours:
      typeof result.data.internal_urgent_timing_hours === "number" ? result.data.internal_urgent_timing_hours : null,
    external_timing_days: typeof result.data.external_timing_days === "number" ? result.data.external_timing_days : null,
    iro_assignment_method: typeof result.data.iro_assignment_method === "string" ? result.data.iro_assignment_method : null,
    filing_methods: filingMethods,
    state_doi_complaint_text:
      typeof result.data.state_doi_complaint_text === "string" ? result.data.state_doi_complaint_text : null,
    full_text: typeof result.data.full_text === "string" ? result.data.full_text : "",
    source_excerpt: typeof result.data.source_excerpt === "string" ? result.data.source_excerpt.slice(0, 200) : "",
    source_excerpt_verified: "not_found",
    source_excerpt_extraction_method: extractionMethod,
    source_section_hint: "appeals_procedures",
    source_section_verified: false,
    haiku_confidence: typeof result.data.haiku_confidence === "number" ? result.data.haiku_confidence : undefined,
  };

  return {
    section_type: "appeals_procedures",
    section_range: sectionRange,
    data,
    haiku_input_tokens: result.inputTokens,
    haiku_output_tokens: result.outputTokens,
    haiku_cost_usd: result.costUsd,
    warnings: result.warnings,
  };
}
