/**
 * FROZEN ROLLBACK SNAPSHOT — the EOC medical_necessity INSTRUCTIONS_BODY exactly as it shipped at
 * PROD commit c21fa0b (post-D1, pre-P2 content-type routing). Used ONLY when the
 * `eoc_prose_prior_auth_v1` flag is OFF, so a flag-OFF EOC parse is byte-identical to post-D1 —
 * the ship gate's "clean rollback" guarantee (M1 fix, Service Thesaurus P2).
 *
 * DO NOT EDIT. This is a pinned historical snapshot, NOT a live prompt. The live (flag-ON) prompt is
 * `INSTRUCTIONS_BODY` in ./medical-necessity.ts. Byte-identity (both directions) is asserted by the
 * scripts/calibration/fixtures/thesaurus-phase1a/eoc-mn-prompt-gate.ts fixture. To change the EOC
 * medical_necessity prompt, change the LIVE one; this stays frozen.
 */
export const INSTRUCTIONS_BODY_PRE_P2 = `You are extracting Medical Necessity Criteria from an Evidence of Coverage (EOC) document section. Return a single JSON object listing the criteria per service.

## CRITICAL EXTRACTION RULES

1. **Verbatim source_excerpt** per criterion (≤200 chars). MUST be a CHARACTER-FOR-CHARACTER substring of the document section text — NEVER paraphrase, summarize, or normalize whitespace/punctuation. If you cannot find a verbatim ≤200-char span that supports the field, set source_excerpt to "" (empty) — the verifier marks empty as 'not_found' (graceful degradation), which is the correct outcome rather than a wrong excerpt.
2. **service_slug_hint**: emit a CANONICAL service slug from the "CANONICAL SERVICE SLUG VOCABULARY" section below (e.g., "bariatric_surgery", "pcp_visit", "specialist_visit", "pt_rehab", "advanced_imaging"). For a service that GENUINELY doesn't fit ANY canonical slug, emit \`proposed_<snake_case_descriptive_name>\` (e.g., \`proposed_hyperbaric_oxygen_therapy\`). NEVER invent a bare snake_case slug — either use a listed canonical OR use \`proposed_*\`. Set null only if no service is identifiable.
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

## OUTPUT FAILURE MODE

If you cannot quote verbatim with high confidence, return:
  "source_excerpt": ""
  "haiku_confidence": (lower value reflecting uncertainty)
The verifier marks empty excerpts as 'not_found' — graceful degradation to display-only rendering. This is preferred over a wrong excerpt that will fail verification.

## CORRECT vs INCORRECT EXCERPT EXAMPLES

Source text in section: "Bariatric surgery is medically necessary when the member has BMI ≥40, OR BMI ≥35 with at least one documented comorbidity (Type 2 diabetes E11.9, hypertension I10)."

❌ INCORRECT (paraphrased): "BMI must be 40 or higher, or 35 with a comorbidity"
Why wrong: not a substring of the document.

❌ INCORRECT (whitespace adjusted): "BMI ≥40 OR BMI ≥35 with comorbidity"
Why wrong: collapsed punctuation and dropped commas; not exact-match.

❌ INCORRECT (semantically right but from wrong location): "Pre-authorization is required for bariatric surgery"
Why wrong: from the prior_auth section, not the medical_necessity criteria.

✅ CORRECT (verbatim substring of source): "BMI ≥40, OR BMI ≥35 with at least one documented comorbidity"

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

`;
