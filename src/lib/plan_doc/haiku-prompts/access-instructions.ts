/**
 * Plan_doc access-instructions Haiku prompt.
 *
 * Extracts plan-level customer-service contact + network finder URL + per-domain
 * contacts (e.g., behavioral health, prescription benefits). Per-service access
 * instructions are extracted in services-cost-sharing.ts; this prompt covers
 * PLAN-LEVEL fallback info only — what the UI surfaces when per-service instructions
 * aren't available (per master plan §S72 access-instructions render priority chain).
 */

import type { ExtractionMethod } from "../../parser/types";
import type {
  PlanDocAccessInstructions,
  PlanDocSectionResult,
  PlanDocPatternP8Provenance,
} from "../types";
import { callHaikuWithCache } from "./_shared";

const INSTRUCTIONS = `You are extracting plan-level access instructions from a Plan Document section. Return a single JSON object with customer service contact + network finder + per-domain contacts.

## CRITICAL EXTRACTION RULES

1. **Verbatim source_excerpt per field** (≤200 chars): CHARACTER-FOR-CHARACTER substring of section text. NEVER paraphrase. Set to "" if unable (graceful 'not_found').

2. **customerServicePhone**: the primary member services phone number. Extract verbatim including format (e.g., "1-800-244-6224" or "(800) 244-6224"). null if not specified.

3. **networkFinderUrl**: URL to find in-network providers (e.g., "cigna.com/find-care", "mycigna.com/find-care"). null if not specified.

4. **domainContacts**: per-domain customer service phone numbers when separately listed (e.g., behavioral health, prescription benefits, dental). Keys: snake_case domain names. Values: verbatim phone numbers. {} (empty object) when no domain-specific contacts present.

## RESPONSE SCHEMA

{
  "customerServicePhone": { "value": "1-800-244-6224", "source_excerpt": "Customer Service: 1-800-244-6224", "haiku_confidence": 0.97 },
  "networkFinderUrl": { "value": "cigna.com/find-care", "source_excerpt": "Find providers at cigna.com/find-care", "haiku_confidence": 0.94 },
  "domainContacts": {
    "behavioral_health": "1-800-274-7603",
    "prescription_benefits": "1-800-285-4812"
  },
  "domainContacts_source_excerpt": "Behavioral Health: 1-800-274-7603 | Prescription Benefits: 1-800-285-4812",
  "domainContacts_haiku_confidence": 0.91
}

If no domain-specific contacts are listed, omit the domainContacts_source_excerpt + domainContacts_haiku_confidence fields and set domainContacts to {}.

## NOW EXTRACT FROM THIS DOCUMENT SECTION:`;

interface RawField<T> {
  value?: T | null;
  source_excerpt?: string;
  haiku_confidence?: number;
}

interface RawResponse {
  customerServicePhone?: RawField<string>;
  networkFinderUrl?: RawField<string>;
  domainContacts?: Record<string, string>;
  domainContacts_source_excerpt?: string;
  domainContacts_haiku_confidence?: number;
}

function buildField(
  raw: RawField<string> | undefined,
  extractionMethod: ExtractionMethod,
): { value: string | null; patternP8: PlanDocPatternP8Provenance; haikuConfidence?: number } {
  const value = typeof raw?.value === "string" && raw.value.length > 0 ? raw.value : null;
  const sourceExcerpt = typeof raw?.source_excerpt === "string" ? raw.source_excerpt.slice(0, 200) : "";
  return {
    value,
    patternP8: {
      source_excerpt: sourceExcerpt,
      source_excerpt_verified: "not_found",
      source_excerpt_extraction_method: extractionMethod,
      source_section_hint: "access_instructions",
      source_section_verified: false,
    },
    haikuConfidence: typeof raw?.haiku_confidence === "number" ? raw.haiku_confidence : undefined,
  };
}

export async function extractAccessInstructions(
  sectionText: string,
  sectionRange: { start: number; end: number },
  extractionMethod: ExtractionMethod,
): Promise<PlanDocSectionResult<PlanDocAccessInstructions>> {
  const result = await callHaikuWithCache<RawResponse>({
    systemPrompt: INSTRUCTIONS,
    userContent: sectionText,
    sectionLabel: "access_instructions",
  });

  const data: PlanDocAccessInstructions = {
    customerServicePhone: buildField(result.data.customerServicePhone, extractionMethod),
    networkFinderUrl: buildField(result.data.networkFinderUrl, extractionMethod),
    domainContacts:
      result.data.domainContacts && typeof result.data.domainContacts === "object"
        ? result.data.domainContacts
        : {},
    domainContactsPatternP8: result.data.domainContacts_source_excerpt
      ? {
          source_excerpt: String(result.data.domainContacts_source_excerpt).slice(0, 200),
          source_excerpt_verified: "not_found",
          source_excerpt_extraction_method: extractionMethod,
          source_section_hint: "access_instructions",
          source_section_verified: false,
        }
      : null,
  };

  return {
    section_type: "access_instructions",
    section_range: sectionRange,
    data,
    haiku_input_tokens: result.inputTokens,
    haiku_output_tokens: result.outputTokens,
    haiku_cost_usd: result.costUsd,
    warnings: result.warnings,
  };
}
