/**
 * EOC Section K — Definitions.
 * Per [[plans/findings/eoc_field_differential]] §1.2 K.
 *
 * Legal definitions of key terms (medical necessity, emergency, custodial care,
 * experimental/investigational, urgent care, observation status, etc.) — high-leverage
 * for dispute-letter inline citation.
 */

import type { ExtractionMethod } from "../../parser/types";
import type { DefinitionEntry, DefinitionsData, EOCSectionResult } from "../types";
import { callHaikuWithCache } from "./_shared";

const INSTRUCTIONS = `You are extracting Definitions from an Evidence of Coverage (EOC) document section. Return a single JSON object listing each defined term + verbatim definition text.

## CRITICAL EXTRACTION RULES

1. **Verbatim source_excerpt** per definition (≤200 chars). MUST be a CHARACTER-FOR-CHARACTER substring of the document section text — NEVER paraphrase, summarize, or normalize whitespace/punctuation. If you cannot find a verbatim ≤200-char span that supports the field, set source_excerpt to "" (empty) — the verifier marks empty as 'not_found' (graceful degradation), which is the correct outcome rather than a wrong excerpt.
2. **term**: the defined term as written (preserve original capitalization; e.g., "Medical Necessity", "Emergency Medical Condition").
3. **definition_text**: verbatim full definition text (do NOT summarize). May be multi-sentence.
4. **DO NOT extract**: cross-references to definitions in other documents, glossary that just lists terms without definitions, header marketing copy that uses defined terms.
5. **source_section_hint**: always 'definitions'.
6. **Vertical-stacked layout**: when source has term on its own line(s) followed by a blank line and then the definition (no inline "Term: definition" or "Term — definition" separator), DO NOT fabricate a separator in source_excerpt. Quote ONLY the definition portion as source_excerpt — do NOT prepend "Term: " or "Term — " to make it readable. The term goes in the term field; source_excerpt is verbatim ONLY.

## RESPONSE SCHEMA

{
  "definitions": [
    {
      "term": "Medical Necessity",
      "definition_text": "Health care services or supplies needed to diagnose or treat an illness, injury, condition, disease, or its symptoms and that meet accepted standards of medicine.",
      "source_excerpt": "verbatim ≤200 chars from the EOC where this definition appears",
      "source_section_hint": "definitions",
      "haiku_confidence": 0.96
    }
  ]
}

## OUTPUT FAILURE MODE

If you cannot quote verbatim with high confidence, return:
  "source_excerpt": ""
  "haiku_confidence": (lower value reflecting uncertainty)
The verifier marks empty excerpts as 'not_found' — graceful degradation to display-only rendering. This is preferred over a wrong excerpt that will fail verification.

## CORRECT vs INCORRECT EXCERPT EXAMPLES

Source text in section: "Medical Emergency: a sudden onset of a medical condition that, if not treated immediately, could reasonably result in serious impairment of bodily function."

❌ INCORRECT (paraphrased): "Medical emergency means an urgent condition needing immediate care"
Why wrong: not a substring of the document.

❌ INCORRECT (whitespace adjusted): "Medical Emergency a sudden onset of a medical condition if not treated immediately could result in serious impairment"
Why wrong: dropped colon, commas, "that", "reasonably", "of bodily function" — not exact-match.

❌ INCORRECT (semantically right but from wrong location): "Emergency services are covered without prior authorization"
Why wrong: from the prior_auth_codes or coverage section, not the definitions glossary entry.

✅ CORRECT (verbatim substring of source): "Medical Emergency: a sudden onset of a medical condition that, if not treated immediately"

## EXAMPLE

EOC text snippet:
"DEFINITIONS

Medical Necessity — Health care services or supplies needed to diagnose or treat an illness, injury, condition, disease, or its symptoms and that meet accepted standards of medicine.

Emergency Medical Condition — A medical condition manifesting itself by acute symptoms of sufficient severity (including severe pain) such that a prudent layperson, who possesses an average knowledge of health and medicine, could reasonably expect the absence of immediate medical attention to result in serious jeopardy to the health of the individual."

Correct extraction:
{
  "definitions": [
    {
      "term": "Medical Necessity",
      "definition_text": "Health care services or supplies needed to diagnose or treat an illness, injury, condition, disease, or its symptoms and that meet accepted standards of medicine.",
      "source_excerpt": "Medical Necessity — Health care services or supplies needed to diagnose or treat an illness, injury, condition, disease, or its symptoms",
      "source_section_hint": "definitions",
      "haiku_confidence": 0.97
    },
    {
      "term": "Emergency Medical Condition",
      "definition_text": "A medical condition manifesting itself by acute symptoms of sufficient severity (including severe pain) such that a prudent layperson, who possesses an average knowledge of health and medicine, could reasonably expect the absence of immediate medical attention to result in serious jeopardy to the health of the individual.",
      "source_excerpt": "Emergency Medical Condition — A medical condition manifesting itself by acute symptoms of sufficient severity (including severe pain)",
      "source_section_hint": "definitions",
      "haiku_confidence": 0.95
    }
  ]
}

## NOW EXTRACT FROM THIS DOCUMENT SECTION:`;

interface RawResponse {
  definitions?: Array<Record<string, unknown>>;
}

export async function extractDefinitions(
  sectionText: string,
  sectionRange: { start: number; end: number },
  extractionMethod: ExtractionMethod,
): Promise<EOCSectionResult<DefinitionsData>> {
  const result = await callHaikuWithCache<RawResponse>({
    systemPrompt: INSTRUCTIONS,
    userContent: sectionText,
    sectionLabel: "definitions",
  });

  const definitions: DefinitionEntry[] = (result.data.definitions ?? [])
    .map((raw): DefinitionEntry | null => {
      const term = typeof raw.term === "string" ? raw.term.trim() : null;
      const definitionText = typeof raw.definition_text === "string" ? raw.definition_text : null;
      if (!term || !definitionText) return null;
      return {
        term,
        definition_text: definitionText,
        source_excerpt: typeof raw.source_excerpt === "string" ? raw.source_excerpt.slice(0, 200) : "",
        source_excerpt_verified: "not_found",
        source_excerpt_extraction_method: extractionMethod,
        source_section_hint: "definitions",
        source_section_verified: false,
        haiku_confidence: typeof raw.haiku_confidence === "number" ? raw.haiku_confidence : undefined,
      };
    })
    .filter((d): d is DefinitionEntry => d !== null);

  return {
    section_type: "definitions",
    section_range: sectionRange,
    data: { definitions },
    haiku_input_tokens: result.inputTokens,
    haiku_output_tokens: result.outputTokens,
    haiku_cost_usd: result.costUsd,
    warnings: result.warnings,
  };
}
