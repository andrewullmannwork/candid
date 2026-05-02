/**
 * SBC "Excluded Services & Other Covered Services" section — list of non-covered services.
 *
 * Returns simple list of service descriptions (verbatim). Federal SBC template
 * always has this section as a comma-separated list following the heading "Services
 * Your Plan Generally Does NOT Cover".
 */

import type { ExtractionMethod } from "../../parser/types";
import { callHaikuWithCache } from "@/lib/haiku-client/base";
import type { SBCPatternP8Provenance, SBCSectionResult } from "../types";

const INSTRUCTIONS = `You are extracting the list of EXCLUDED services from the "Excluded Services & Other Covered Services" section of an SBC document. Return a single JSON object with the verbatim list.

## CRITICAL EXTRACTION RULES

1. **Verbatim source_excerpt** of the FULL excluded services list (≤200 chars). MUST be a CHARACTER-FOR-CHARACTER substring of the document section text.
2. **excludedServices** array: extract each EXCLUDED service as a separate string entry, verbatim from the SBC. Do NOT modify capitalization or wording.
3. **Federal SBC template** always lists excluded services after the heading "Services Your Plan Generally Does NOT Cover" — extract from THAT subsection only, not from "Other Covered Services" (which lists covered-with-limits services).
4. **Do not include** the heading text itself in the source_excerpt or the array.
5. **source_section_hint**: always "excluded_services".

## RESPONSE SCHEMA

{
  "excludedServices": [
    "chiropractic care",
    "cosmetic surgery",
    "dental care (adult)",
    "hearing aids",
    "infertility treatment",
    "long-term care",
    "non-emergency care when traveling outside the U.S.",
    "private-duty nursing",
    "routine eye care (adult)",
    "routine foot care",
    "weight loss programs"
  ],
  "source_excerpt": "Chiropractic care, Cosmetic surgery, Dental care (Adult), Hearing aids, Infertility treatment, Long-term care, Non-emergency care when traveling outside the U.S., Private-duty nursing, Routine eye care (Adult), Routine foot care, Weight loss programs",
  "source_section_hint": "excluded_services",
  "haiku_confidence": 0.96
}

If no excluded list found, return:
{
  "excludedServices": [],
  "source_excerpt": "",
  "source_section_hint": "excluded_services",
  "haiku_confidence": 0.0
}

## OUTPUT FAILURE MODE

If you cannot quote verbatim with high confidence, return:
  "source_excerpt": ""
  "haiku_confidence": (lower value reflecting uncertainty)
The verifier marks empty excerpts as 'not_found' — graceful degradation.

## NOW EXTRACT FROM THIS DOCUMENT SECTION:`;

interface RawResponse {
  excludedServices?: unknown;
  source_excerpt?: unknown;
  haiku_confidence?: unknown;
}

export interface ExcludedServicesData {
  excludedServices: string[];
  patternP8: SBCPatternP8Provenance | null;
  haikuConfidence?: number;
}

export async function extractExcludedServices(
  sectionText: string,
  sectionRange: { start: number; end: number },
  extractionMethod: ExtractionMethod,
): Promise<SBCSectionResult<ExcludedServicesData>> {
  const result = await callHaikuWithCache<RawResponse>({
    systemPrompt: INSTRUCTIONS,
    userContent: sectionText,
    sectionLabel: "sbc/excluded_services",
  });

  const list = Array.isArray(result.data.excludedServices)
    ? result.data.excludedServices.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    : [];

  const sourceExcerpt = typeof result.data.source_excerpt === "string" ? result.data.source_excerpt.slice(0, 200) : "";
  const patternP8: SBCPatternP8Provenance | null = sourceExcerpt
    ? {
        source_excerpt: sourceExcerpt,
        source_excerpt_verified: "not_found",
        source_excerpt_extraction_method: extractionMethod,
        source_section_hint: "excluded_services",
        source_section_verified: false,
      }
    : null;

  return {
    section_type: "excluded_services",
    section_range: sectionRange,
    data: {
      excludedServices: list,
      patternP8,
      haikuConfidence: typeof result.data.haiku_confidence === "number" ? result.data.haiku_confidence : undefined,
    },
    haiku_input_tokens: result.inputTokens,
    haiku_output_tokens: result.outputTokens,
    haiku_cost_usd: result.costUsd,
    warnings: result.warnings,
  };
}
