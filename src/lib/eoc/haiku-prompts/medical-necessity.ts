/**
 * EOC Section B — Medical Necessity Criteria.
 * Per [[plans/findings/eoc_field_differential]] §1.2 B.
 *
 * Note: ICD-10 diagnosis codes referenced here are stored as `diagnosis_qualifiers`
 * (string array) on the criterion row — they do NOT enter `concept_admin_review_queue`
 * per Q-DR-3.1A-B-2 LOCK (queue is for billing codes only, not diagnosis codes).
 */

import type { ExtractionMethod } from "../../parser/types";
import type { EOCSectionResult, MedicalNecessityContentType, MedicalNecessityCriterion, MedicalNecessityData, PriorAuthPolarity } from "../types";
import { callHaikuWithCache } from "./_shared";
import { INSTRUCTIONS_BODY_PRE_P2 } from "./medical-necessity-pre-p2";
import { HAIKU_CACHE_PAD } from "@/lib/haiku-client/cache-pad";

const INSTRUCTIONS_BODY = `You are extracting Medical Necessity Criteria from an Evidence of Coverage (EOC) document section. Return a single JSON object listing the criteria per service.

## CRITICAL EXTRACTION RULES

1. **Verbatim source_excerpt** per criterion (≤200 chars). MUST be a CHARACTER-FOR-CHARACTER substring of the document section text — NEVER paraphrase, summarize, or normalize whitespace/punctuation. If you cannot find a verbatim ≤200-char span that supports the field, set source_excerpt to "" (empty) — the verifier marks empty as 'not_found' (graceful degradation), which is the correct outcome rather than a wrong excerpt.
2. **service_slug_hint**: emit a CANONICAL service slug from the "CANONICAL SERVICE SLUG VOCABULARY" section below (e.g., "bariatric_surgery", "pcp_visit", "specialist_visit", "pt_rehab", "advanced_imaging"). For a service that GENUINELY doesn't fit ANY canonical slug, emit \`proposed_<snake_case_descriptive_name>\` (e.g., \`proposed_hyperbaric_oxygen_therapy\`). NEVER invent a bare snake_case slug — either use a listed canonical OR use \`proposed_*\`. Set null only if no service is identifiable.
3. **criteria_text**: verbatim full criteria description (NOT summarized). May be multi-sentence.
4. **diagnosis_qualifiers**: extract any ICD-10 diagnosis codes referenced in the criteria (e.g., "E66.01" for obesity). Empty array if none. These codes are NOT extracted as billing codes — they are conditions of coverage.
5. **DO NOT extract**: criteria from glossary cross-references, header marketing, or footer disclaimers.
6. **source_section_hint**: always 'medical_necessity'.

## CONTENT TYPE CLASSIFICATION (REQUIRED on every entry)

This region of the EOC intermixes THREE kinds of fact. Label each entry with **type** and **type_confidence** (0-1 — how sure you are of the LABEL, not of the extraction):

- **clinical_criterion** — a medical-necessity condition, or a coverage limit/exclusion. Signals: "is medically necessary when…", "covered when…", "covered except…", "limited to N visits/days". Use for a genuine per-service clinical rule. This is the default when a fact is a real coverage rule and neither type below applies.
- **prior_auth** — the service needs APPROVAL or a service-specific REFERRAL BEFORE it is covered. Trigger phrases (any of): "prior authorization", "prior authorisation", "pre-authorization", "preauthorization", "pre-certification", "precertification", "prior approval", "prior review", "step therapy" (must try another treatment first), "must be authorized in advance", AND a service-specific referral gate ("coverage for X requires referral by a doctor"). prior_auth is PERMISSION-before-service — NOT the clinical conditions for necessity. NOTE the referral line: a *general* access description ("see your PCP for referrals"; "you do not need a referral") is admin_provision; a referral stated as a coverage CONDITION for a specific service ("coverage for physical therapy requires referral") is prior_auth.
- **admin_provision** — administrative / coverage mechanics that are neither a per-service clinical rule nor a prior-auth: out-of-area rules, GENERAL network/referral mechanics, member rights, post-stabilization, cost-share mechanics, continuity-of-care. Signals: "outside the service area", "network provider", "you have the right to", "the member may".

### CLASSIFICATION RULES
- **C1 — one entry = one fact of one type.** If a passage states BOTH a clinical criterion AND a prior-auth requirement (very common — e.g. "covered when BMI ≥40 … and requires prior authorization"), emit **TWO separate entries**: one clinical_criterion for the clinical condition, one prior_auth for the approval requirement. Never collapse them — each must route to its own destination.
- **C2 — fact-scoped excerpt on a split.** Each entry's source_excerpt must be the verbatim span supporting THAT entry's fact: the clinical entry quotes the criteria span; the prior_auth entry quotes the "requires prior authorization" span. Never reuse one excerpt for both.
- **C3 — a mention is not a relabel.** A clinical criterion that merely *mentions* PA is still split: the clinical part stays clinical_criterion; only the approval sentence becomes prior_auth. Do not retype a whole clinical rule as prior_auth just because PA appears in it.
- **C4 — split entries share one service_slug_hint.** Both halves describe the same service; set the same service_slug_hint identically on each.
- **C5 — PA polarity (REQUIRED on every prior_auth entry).** Set **pa_polarity**: "requires" if the text IMPOSES approval/referral before coverage; "waived" if it states approval is NOT required / is waived ("you do not need prior authorization", "will not impose prior authorization", "no precertification required"). A "waived" entry is STILL prior_auth — it records the absence; only "requires" gates coverage. (Non-PA entries: omit or null.)
- **C6 — axis scope (place_of_service).** If a prior_auth or coverage rule applies to a place-of-service AXIS rather than one service ("all INPATIENT admissions require precert", "OUTPATIENT surgery"), set **place_of_service** ("inpatient" | "outpatient" | "office" | "emergency" | "home" | …) and leave service_slug_hint null (unless one specific service is also named). For a CARVE-OUT ("all inpatient require precert EXCEPT maternity"), emit TWO entries: the broad axis fact (place_of_service:"inpatient", pa_polarity:"requires", service_slug_hint:null) AND the exception (service_slug_hint:"maternity_care", place_of_service:"inpatient", pa_polarity:"waived").

## RESPONSE SCHEMA

{
  "criteria": [
    {
      "type": "clinical_criterion",  // or "prior_auth" or "admin_provision" (see CONTENT TYPE CLASSIFICATION)
      "type_confidence": 0.95,
      "pa_polarity": null,  // "requires" | "waived" — REQUIRED when type is "prior_auth"; null otherwise (C5)
      "place_of_service": null,  // "inpatient" | "outpatient" | … when axis-scoped; null when service-scoped (C6)
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

Correct extraction (note the SPLIT per C1/C2 — the passage states a clinical criterion AND a prior-auth requirement, so it yields TWO entries with the SAME service_slug_hint and FACT-SCOPED excerpts):
{
  "criteria": [
    {
      "type": "clinical_criterion",
      "type_confidence": 0.96,
      "pa_polarity": null,
      "place_of_service": null,
      "service_slug_hint": "bariatric_surgery",
      "criteria_text": "Bariatric surgery is medically necessary when the member meets ALL of the following: 1. BMI ≥40, OR BMI ≥35 with at least one documented comorbidity (Type 2 diabetes E11.9, hypertension I10, obstructive sleep apnea G47.33, or osteoarthritis M19.91) 2. Documentation of 6 consecutive months of supervised weight loss program within the past 24 months 3. Psychological evaluation confirming readiness for surgery",
      "diagnosis_qualifiers": ["E11.9", "I10", "G47.33", "M19.91"],
      "source_excerpt": "Bariatric surgery is medically necessary when the member meets ALL of the following: 1. BMI ≥40, OR BMI ≥35 with at least one documented comorbidity",
      "source_section_hint": "medical_necessity",
      "haiku_confidence": 0.95
    },
    {
      "type": "prior_auth",
      "type_confidence": 0.98,
      "pa_polarity": "requires",
      "place_of_service": null,
      "service_slug_hint": "bariatric_surgery",
      "criteria_text": "Coverage requires prior authorization.",
      "diagnosis_qualifiers": [],
      "source_excerpt": "Coverage requires prior authorization",
      "source_section_hint": "medical_necessity",
      "haiku_confidence": 0.97
    }
  ]
}

## AXIS CARVE-OUT EXAMPLE (C6 — one passage, axis rule + its exception → TWO entries)

Source: "All inpatient admissions require precertification, except inpatient maternity stays."

{
  "criteria": [
    {
      "type": "prior_auth",
      "type_confidence": 0.95,
      "pa_polarity": "requires",
      "place_of_service": "inpatient",
      "service_slug_hint": null,
      "criteria_text": "All inpatient admissions require precertification",
      "diagnosis_qualifiers": [],
      "source_excerpt": "All inpatient admissions require precertification",
      "source_section_hint": "medical_necessity",
      "haiku_confidence": 0.95
    },
    {
      "type": "prior_auth",
      "type_confidence": 0.92,
      "pa_polarity": "waived",
      "place_of_service": "inpatient",
      "service_slug_hint": "maternity_care",
      "criteria_text": "except inpatient maternity stays",
      "diagnosis_qualifiers": [],
      "source_excerpt": "except inpatient maternity stays",
      "source_section_hint": "medical_necessity",
      "haiku_confidence": 0.9
    }
  ]
}

`;

/**
 * Build the medical-necessity system prompt. When the live catalog `serviceVocabulary` block is
 * provided (always, in PROD — `process-eoc` loads it), it is appended so Haiku maps to a real slug
 * instead of inventing one (Pattern S Hard Rule #17). On a vocab-load failure the block is empty →
 * graceful degradation to the (still anti-invention) rules above, never the old "best-guess" prompt.
 *
 * `contentTypeRoutingOn` gates the P2 type-classification + C1 split (the `eoc_prose_prior_auth_v1`
 * flag): OFF → the FROZEN pre-P2 body (`INSTRUCTIONS_BODY_PRE_P2`), so a flag-OFF parse is
 * INSTRUCTION-byte-identical to post-D1 modulo the always-on cache pad (carve-out D7, S187 — the
 * pad is prepended in BOTH flag states by construction, so the flag still toggles ONLY the P2
 * type/split block; no split → no `coverage_rules` clobber — M1 fix). The flag is read once
 * in `process-eoc` and threaded here via `parseEOC` options. Default OFF = fail-toward-today (an
 * un-updated caller gets the safe pre-P2 prompt). Exported for the byte-identity fixture (both directions).
 */
export function buildMedicalNecessityPrompt(serviceVocabulary?: string, contentTypeRoutingOn = false): string {
  const body = contentTypeRoutingOn ? INSTRUCTIONS_BODY : INSTRUCTIONS_BODY_PRE_P2;
  const vocab = serviceVocabulary && serviceVocabulary.trim().length > 0 ? `\n\n${serviceVocabulary}` : "";
  return `${HAIKU_CACHE_PAD}${body}${vocab}\n\n## NOW EXTRACT FROM THIS DOCUMENT SECTION:`;
}

interface RawResponse {
  criteria?: Array<Record<string, unknown>>;
}

const VALID_CONTENT_TYPES = new Set<MedicalNecessityContentType>([
  "clinical_criterion",
  "prior_auth",
  "admin_provision",
]);

/** Normalize a free-text place_of_service axis to a lowercase token, or null. */
function coercePlaceOfService(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.toLowerCase().trim();
  return s.length > 0 ? s : null;
}

/**
 * Coerce Haiku's raw classification fields (`type` / `type_confidence` / `pa_polarity` / `place_of_service`),
 * with a FAIL-TOWARD-TODAY default: a missing or invalid `type` becomes `clinical_criterion` at
 * `type_confidence = 0`, so the fact lands exactly where it landed before P2 (`coverage_rules` — zero
 * regression vs post-D1). NOTE: `routeCriterion` reads `type_confidence` ONLY on the `prior_auth`+`requires`
 * branch (the user-visible column write); a `clinical_criterion` routes to `coverage_rules` at face value
 * regardless of confidence — there is NO review gate on it. Only prose prior-auth surfacing is confidence-gated.
 * `pa_polarity` is set ONLY for an explicit "requires"/"waived" on a prior_auth — otherwise null
 * (uncertain), which the router treats as fail-toward-safe (NOT surfaced to the column).
 */
function coerceClassification(raw: Record<string, unknown>): {
  type: MedicalNecessityContentType;
  type_confidence: number | null;
  pa_polarity: PriorAuthPolarity | null;
  place_of_service: string | null;
} {
  const place_of_service = coercePlaceOfService(raw.place_of_service);
  const valid =
    typeof raw.type === "string" && VALID_CONTENT_TYPES.has(raw.type as MedicalNecessityContentType)
      ? (raw.type as MedicalNecessityContentType)
      : null;
  if (!valid) return { type: "clinical_criterion", type_confidence: 0, pa_polarity: null, place_of_service };
  const tc =
    typeof raw.type_confidence === "number" && raw.type_confidence >= 0 && raw.type_confidence <= 1
      ? raw.type_confidence
      : null;
  const pa_polarity: PriorAuthPolarity | null =
    valid === "prior_auth" && (raw.pa_polarity === "requires" || raw.pa_polarity === "waived")
      ? raw.pa_polarity
      : null;
  return { type: valid, type_confidence: tc, pa_polarity, place_of_service };
}

/**
 * Pure parse of Haiku's raw criteria array into typed `MedicalNecessityCriterion[]`. Exported so the
 * T1 logic fixture exercises the type-coercion + shape WITHOUT a live Haiku call (parser-independent,
 * per [[feedback_calibration_independence]]). `extractMedicalNecessity` is the thin Haiku-calling shell.
 */
export function parseMedicalNecessityCriteria(
  rawCriteria: Array<Record<string, unknown>> | undefined,
  extractionMethod: ExtractionMethod,
): MedicalNecessityCriterion[] {
  return (rawCriteria ?? [])
    .map((raw): MedicalNecessityCriterion | null => {
      const criteriaText = typeof raw.criteria_text === "string" ? raw.criteria_text : null;
      if (!criteriaText) return null;
      const sourceExcerpt = typeof raw.source_excerpt === "string" ? raw.source_excerpt.slice(0, 200) : "";
      const dxQualifiers = Array.isArray(raw.diagnosis_qualifiers)
        ? raw.diagnosis_qualifiers.filter((d): d is string => typeof d === "string")
        : [];
      const { type, type_confidence, pa_polarity, place_of_service } = coerceClassification(raw);
      return {
        service_slug_hint: typeof raw.service_slug_hint === "string" ? raw.service_slug_hint : null,
        criteria_text: criteriaText,
        diagnosis_qualifiers: dxQualifiers,
        type,
        type_confidence,
        pa_polarity,
        place_of_service,
        source_excerpt: sourceExcerpt,
        source_excerpt_verified: "not_found",
        source_excerpt_extraction_method: extractionMethod,
        source_section_hint: "medical_necessity",
        source_section_verified: false,
        haiku_confidence: typeof raw.haiku_confidence === "number" ? raw.haiku_confidence : undefined,
      };
    })
    .filter((c): c is MedicalNecessityCriterion => c !== null);
}

export async function extractMedicalNecessity(
  sectionText: string,
  sectionRange: { start: number; end: number },
  extractionMethod: ExtractionMethod,
  serviceVocabulary?: string,
  contentTypeRoutingOn = false,
): Promise<EOCSectionResult<MedicalNecessityData>> {
  const result = await callHaikuWithCache<RawResponse>({
    systemPrompt: buildMedicalNecessityPrompt(serviceVocabulary, contentTypeRoutingOn),
    userContent: sectionText,
    sectionLabel: "medical_necessity",
  });

  const criteria = parseMedicalNecessityCriteria(result.data.criteria, extractionMethod);

  return {
    section_type: "medical_necessity",
    section_range: sectionRange,
    data: { criteria },
    haiku_input_tokens: result.inputTokens,
    haiku_output_tokens: result.outputTokens,
    haiku_cost_usd: result.costUsd,
    haiku_cache_create_tokens: result.cacheCreateTokens ?? 0,
    haiku_cache_read_tokens: result.cacheReadTokens ?? 0,
    warnings: result.warnings,
  };
}
