/**
 * SBC "Your Grievance and Appeals Rights" section — appeals contact info + procedures.
 *
 * Federal SBC template always has this section near the back of the document.
 * Some insurers (e.g., Blue Shield) have multi-category grievance contacts (separate
 * medical/Rx/MHSA/dental contact info) — supports multi-entry output.
 */

import type { ExtractionMethod } from "../../parser/types";
import { callHaikuWithCache } from "@/lib/haiku-client/base";
import type { SBCHaikuAppealsContact, SBCPatternP8Provenance, SBCSectionResult } from "../types";

const INSTRUCTIONS = `You are extracting appeals/grievance contact information from the "Your Grievance and Appeals Rights" section of an SBC document. Return a single JSON object with one or more contact entries (multi-category support).

## CRITICAL EXTRACTION RULES

1. **Verbatim source_excerpt** per contact entry (≤200 chars) covering the contact block (address + phone). MUST be a CHARACTER-FOR-CHARACTER substring.
2. **Multi-category support**: some SBCs (e.g., Blue Shield) have SEPARATE contact info for different grievance categories (medical/Rx, MHSA Participating, MHSA Non-Participating, pediatric dental). Extract EACH as a separate entry with category label. For single-category SBCs, return one entry with category null.
3. **Address fields**: extract addressLine1, addressLine2, city, state, postalCode, phone individually. Set null for missing fields.
4. **Phone**: format as 10-digit string with no formatting (e.g., "8004447777"). Null if absent.
5. **DO NOT extract** boilerplate language about external review processes — only the contact details (where to send appeals).
6. **source_section_hint**: always "appeals_grievances".

## RESPONSE SCHEMA

{
  "contacts": [
    {
      "category": null,
      "addressLine1": "Blue Shield of California Appeals Department",
      "addressLine2": "P.O. Box 5588",
      "city": "El Dorado Hills",
      "state": "CA",
      "postalCode": "95762",
      "phone": "8004447777",
      "source_excerpt": "Blue Shield of California Appeals Department P.O. Box 5588 El Dorado Hills, CA 95762 1-800-444-7777",
      "source_section_hint": "appeals_grievances",
      "haiku_confidence": 0.95
    }
  ]
}

For multi-category SBCs:
{
  "contacts": [
    { "category": "medical/Rx", "addressLine1": "...", ..., "haiku_confidence": 0.94 },
    { "category": "MHSA Participating", "addressLine1": "...", ..., "haiku_confidence": 0.93 },
    { "category": "pediatric dental", "addressLine1": "...", ..., "haiku_confidence": 0.91 }
  ]
}

## OUTPUT FAILURE MODE

If you cannot quote verbatim with high confidence, return:
  "source_excerpt": ""
  "haiku_confidence": (lower value reflecting uncertainty)
For empty section: return { "contacts": [] }.

## NOW EXTRACT FROM THIS DOCUMENT SECTION:`;

interface RawContact {
  category?: unknown;
  addressLine1?: unknown;
  addressLine2?: unknown;
  city?: unknown;
  state?: unknown;
  postalCode?: unknown;
  phone?: unknown;
  source_excerpt?: unknown;
  haiku_confidence?: unknown;
}

interface RawResponse {
  contacts?: RawContact[];
}

function asNullableString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

export interface AppealsGrievancesData {
  contacts: SBCHaikuAppealsContact[];
}

export async function extractAppealsGrievances(
  sectionText: string,
  sectionRange: { start: number; end: number },
  extractionMethod: ExtractionMethod,
): Promise<SBCSectionResult<AppealsGrievancesData>> {
  const result = await callHaikuWithCache<RawResponse>({
    systemPrompt: INSTRUCTIONS,
    userContent: sectionText,
    sectionLabel: "sbc/appeals_grievances",
  });

  const contacts: SBCHaikuAppealsContact[] = (result.data.contacts ?? []).map(
    (raw): SBCHaikuAppealsContact => {
      const sourceExcerpt = typeof raw.source_excerpt === "string" ? raw.source_excerpt.slice(0, 200) : "";
      const patternP8: SBCPatternP8Provenance = {
        source_excerpt: sourceExcerpt,
        source_excerpt_verified: "not_found",
        source_excerpt_extraction_method: extractionMethod,
        source_section_hint: "appeals_grievances",
        source_section_verified: false,
      };
      return {
        addressLine1: asNullableString(raw.addressLine1),
        addressLine2: asNullableString(raw.addressLine2),
        city: asNullableString(raw.city),
        state: asNullableString(raw.state),
        postalCode: asNullableString(raw.postalCode),
        phone: asNullableString(raw.phone),
        sourceExcerpt: sourceExcerpt || null,
        sourcePage: null,
        confidence: typeof raw.haiku_confidence === "number" ? raw.haiku_confidence : 0.5,
        patternP8,
        category: asNullableString(raw.category) ?? undefined,
      };
    },
  );

  return {
    section_type: "appeals_grievances",
    section_range: sectionRange,
    data: { contacts },
    haiku_input_tokens: result.inputTokens,
    haiku_output_tokens: result.outputTokens,
    haiku_cost_usd: result.costUsd,
    warnings: result.warnings,
  };
}
