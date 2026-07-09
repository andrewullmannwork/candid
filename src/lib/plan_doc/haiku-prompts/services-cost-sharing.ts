/**
 * Plan_doc services + cost-sharing Haiku prompt.
 *
 * Extracts per-service rows including OON cost-sharing columns + per-service
 * `howToAccess` field (populates coverage_rules.how_to_access JSONB per master plan §S72).
 * Pattern P-8 source_excerpt per service row covers all cost-sharing fields since they
 * derive from the same source row.
 */

import type { ExtractionMethod } from "../../parser/types";
import type {
  PlanDocService,
  PlanDocSectionResult,
  PlanDocPatternP8Provenance,
  PlanDocSectionHint,
} from "../types";
import type { PlanDocLayout } from "../layout-detector";
import { loadActiveSupplement } from "../prompt-loader";
import { callHaikuWithCache } from "./_shared";
import { HAIKU_CACHE_PAD } from "@/lib/haiku-client/cache-pad";
import { isFeatureEnabled } from "@/lib/config/product-flags";

const PROMPT_FILE_PATH = "src/lib/plan_doc/haiku-prompts/services-cost-sharing.ts";

// Federal-SBC tabular-extraction supplement. Federally-mandated SBCs use a tight
// table layout where pdftotext splits cells across consecutive lines. Without
// this instruction, the model attempts to synthesize multi-line table rows
// into one excerpt and the verbatim verifier rejects the synthesis. Mirrors
// src/lib/sbc/haiku-prompts/common-medical-events.ts:81 verbatim guidance.
const FEDERAL_SBC_TABULAR_SUPPLEMENT = `

## FEDERAL-SBC LAYOUT — TABULAR EXTRACTION OVERRIDE (read carefully)

This document is a federal Summary of Benefits and Coverage (SBC). pdftotext
extracts SBC table cells across MULTIPLE LINES — a single service row's
cost-sharing info typically spans 2-3 consecutive lines. Example:

\`\`\`
Primary care visit to treat an injury or illness
$30 copay/visit
50% coinsurance
No charge after deductible has been met
\`\`\`

When extracting verbatim source_excerpt for SBC services:
- Quote a SINGLE LINE from the source containing the most distinctive value
  (preferably the in-network cost-sharing line).
- DO NOT attempt to reconstruct multi-line rows into one excerpt — that will
  fail verbatim verification.
- Short verbatim single-line quotes are CORRECT; long reconstructed paraphrases
  are WRONG.
- It is PERFECTLY ACCEPTABLE for the source_excerpt to NOT include the service
  name as long as it contains the cost value verbatim from the source.

This rule supersedes any default tendency to "include the full context" in
the excerpt.`;

// EOC narrative supplement. EOC documents describe coverage in prose paragraphs
// rather than tables. Different verbatim-extraction discipline applies — prose
// sentences are naturally contiguous (no multi-line table splits) so longer
// source_excerpts are appropriate AND verifiable. S94 Work Block B1 Stage 2 addition.
const FULL_EOC_NARRATIVE_SUPPLEMENT = `

## EOC NARRATIVE LAYOUT — PROSE EXTRACTION GUIDANCE

This document is a full Evidence of Coverage (EOC) describing benefits in prose
paragraphs rather than tabular format. pdftotext output here preserves natural
sentence structure (no multi-line table-cell splits).

For source_excerpt:
- Extract a CONTIGUOUS SENTENCE or PHRASE containing the cost-sharing value.
  Example: "You pay 30% coinsurance after the deductible for an in-network optometrist"
- Multi-sentence excerpts up to ~200 chars are acceptable IF they are literally
  adjacent in the source text.
- A service's in-network and out-of-network cost-shares may appear in DIFFERENT
  sentences — emit one service row per service but quote whichever cost-share
  sentence is most distinctive (in-network preferred).
- Service names in EOC prose are often embedded mid-sentence (e.g., "Routine eye
  exams for adults are covered..." rather than as a heading). Look for the
  service mention + nearest cost-sharing phrase.

In-network vs out-of-network identification:
- Tables in SBCs use column headers ("In-Network" | "Out-of-Network"). EOC prose
  uses inline phrasing ("in-network providers", "non-network providers", "out-of-area").
- If a sentence only mentions a single cost-share without network qualifier,
  assume IN-NETWORK and set out* fields to null (do NOT default OON to in-network
  values).

priorAuthRequired in EOC:
- Look for phrases like "requires prior authorization", "preauthorization required",
  "must be obtained before treatment". Set priorAuthRequired=true.
- Source_excerpt should quote the prior-auth sentence directly.`;

// Thesaurus Phase 1a supplement (S173). Appended ONLY when `thesaurus_phase1a_v1` is ON,
// so OFF = byte-identical Haiku output (no extraction drift on the live path). Adds the two
// service-identity fields the resolver-routing (T3) + pos/component corroboration (T4) consume:
// `rawLabel` (verbatim source service name → label→slug routing) + `component`
// (facility|professional|global; a Pattern-S modifier, NOT baked into the slug — Hard Rule #17).
const THESAURUS_PHASE1A_SUPPLEMENT = `

## ADDITIONAL FIELDS — SERVICE IDENTITY (emit these on EVERY service object)

In ADDITION to all fields above, add TWO fields to each service:

- **rawLabel**: the service's NAME/LABEL exactly as it appears in the source — the heading or
  row label you used to recognize this service. NOT the cost-sharing text, NOT a paraphrase.
  Quote the source wording verbatim where possible (≤120 chars). Examples:
    "Primary care visit to treat an injury or illness"
    "Outpatient surgery — Facility fee (e.g., ambulatory surgery center)"
    "Physician/surgeon fees"
    "Tier 2 drugs (Preferred brand)"
  If no distinct service label is identifiable for this row, set rawLabel to null.

- **component**: which billing component this row represents — EXACTLY one of:
    "facility"     → an institutional/facility charge ("Facility fee", ambulatory surgery
                     center, the hospital-facility portion of a stay)
    "professional" → a professional/physician charge ("Physician/surgeon fees", the
                     provider/professional portion)
    "global"       → NOT split into facility vs professional — the DEFAULT for ordinary
                     services (office visits, drugs, labs, imaging, therapy, ER, etc.)
  Use "facility"/"professional" ONLY when the source row is explicitly a facility-only or
  professional-only charge (typically the surgery / inpatient-stay / delivery split). When in
  doubt, use "global".

Example service object with the new fields:
  { "serviceSlug": "outpatient_surgery_physician", "rawLabel": "Physician/surgeon fees",
    "component": "professional", "inCoinsurance": 20, ... }`;

// Cold-start regen extraction v2 (S215). Appended ONLY when `plan_doc_extraction_v2` is ON, so
// OFF = byte-identical Haiku output (no drift on the live path). Codifies the learnings measured
// against Andrew's human-adjudicated multi-dimension oracle (the highest-frequency error classes:
// `$0` dropped as null, not-covered left blank, wrong line picked on multi-variant services).
const EXTRACTION_V2_SUPPLEMENT = `

## EXTRACTION v2 — CODIFIED LEARNINGS (apply EXACTLY; these OVERRIDE any default tendency above)

These fix the highest-frequency errors measured against a human-adjudicated oracle. Follow them precisely.

### L1 — "$0" / "No charge" is a REAL value, NEVER null
"No charge", "No Charge", "$0", "$0 copay", "no cost", "0%", "0% coinsurance", "Covered in full",
"Covered 100%", "Paid in full" → emit 0, NEVER null. Determinism: a bare "No charge"/"$0"/"Covered in
full" with no percentage → \`inCopay: 0\`. A bare "0%"/"0% coinsurance" → \`inCoinsurance: 0\`. Preventive
care is $0 in-network by federal mandate → \`inCopay: 0\` unless the document explicitly states a cost.
(null = "the document did not state this"; 0 = "the member pays nothing" — these are NOT the same.)

### L2 — NOT COVERED is an AFFIRMATIVE state, never a blank
When a service, or one network column, is NOT covered ("Not covered", "Not a covered benefit",
"No coverage", "Excluded", or "Not Applicable" given as the coverage answer) → say so affirmatively:
- whole service not covered → \`covered: false\` (cost fields null).
- the OUT-OF-NETWORK column specifically not covered (common on HMO/EPO) → \`outCostDescription: "Not covered"\`
  with \`outCopay\`/\`outCoinsurance\` null.
NEVER imply "not covered" by leaving a field blank. A blank/omitted field means "the document did not say."

### L3 — Multiple lines for one service: pick the STANDARD line, and keep the others
When a service lists several variants (value-tier vs standard, physician-office vs facility, in-person vs
virtual/telehealth, condition-care/wellness-program vs regular, participating vs non-participating), the
PRIMARY row takes the STANDARD, in-person, regular-network line — NOT the promotional / value-tier /
telehealth / special-program line. Emit each OTHER material variant as its OWN additional service row
(same serviceSlug, different placeOfService). NEVER drop a service because OCR interleaved a page header
("3 of 7", "What You Will Pay", "Common Medical Event") into its row — locate the real cost-sharing.

### L4 — placeOfService: use ONLY the controlled vocabulary in rule 5 above
**Freestanding vs hospital (the #1 place error):** \`independent_facility\` = a FREESTANDING / ambulatory
surgery center (ASC) / independent imaging or lab center — NOT attached to a hospital. \`outpatient_facility\`
= a HOSPITAL outpatient department. When the source says "ambulatory surgery center", "freestanding",
"independent", "(e.g., ambulatory surgery center)", or an imaging/lab center → use \`independent_facility\`,
NOT \`outpatient_facility\`. Use \`outpatient_facility\` only for an explicitly hospital-based outpatient setting.
Pharmacy network tiers: "participating pharmacy" → in-network (\`in*\`); "non-participating pharmacy" →
out-of-network (\`out*\`). Retail vs mail vs specialty → retail_pharmacy / home_delivery_pharmacy /
designated_pharmacy. Never invent a place label outside the rule-5 list.

### L5 — Deductible-applies, BOTH networks (a high-value, under-captured field — work it hard)
Capture \`inDeductibleApplies\` AND \`outDeductibleApplies\` independently, for EVERY service. Sources of truth,
in priority order:
1. **Explicit cell text wins.** "after deductible" / "subject to deductible" / "Deductible + X%" / "then X%" →
   true. "does not apply" / "not subject to deductible" / "deductible waived" / "no charge" → false.
2. **The plan-level deductible statement.** SBCs have an "Are there services covered before you meet your
   deductible?" line (and an overall-deductible row). Services it lists as covered-before-deductible (usually
   preventive, often PCP/generic-Rx) → \`inDeductibleApplies: false\`. If the plan says the deductible applies
   to "all services" / is an HDHP → most services true.
3. **Inference when the cell is silent** (do this rather than leave null): a service priced as a flat **copay**
   with no deductible language → usually \`false\` (copay-first). A service priced as **coinsurance** (a %) with
   no "waived"/"does not apply" language → usually \`true\` (coinsurance almost always follows the deductible).
   Preventive care in-network → \`false\` (federal). Explicit text (1) and the plan-level rule (2) always override
   this inference.
Common asymmetry: in-network deductible-EXEMPT while OON is AFTER the deductible (e.g. "In-network: $15 copay /
Out-of-network: Deductible + $15 copay") → \`inDeductibleApplies: false\`, \`outDeductibleApplies: true\`.

### L6 — A dollar fee AND a coinsurance can BOTH apply
"$300 copay then 50% coinsurance", "$300 + 50%", "$300 then 50%" → \`inCopay: 300\` AND \`inCoinsurance: 50\`
(populate both fields).

### L7 — Per-benefit maximums / payout caps — capture, don't drop
"benefit maximum of $500/day", "limited to $1,000 per year", "up to $X", "X visits/year", "X days/admission"
→ record the cap VERBATIM in \`coverageConditions\` (and \`annualLimitValue\` when it is an annual visit/day
count or dollar cap). Rare but real — do not silently drop it.

### L8 — Prior authorization: "may" still counts, but record the wording
"requires prior authorization" / "preauthorization required" / "precertification required" →
\`priorAuthRequired: true\`. "MAY require prior authorization" / "may need preauthorization" →
\`priorAuthRequired: true\` AND put the exact phrase in \`coverageConditions\` (so it can be shown as
conditional). If the document is SILENT for a service → \`priorAuthRequired: null\` (never infer false).`;

// Coverage-dimensions supplement (coverage_dims_v1). Appended ONLY when the flag is ON, so
// OFF = byte-identical Haiku output (no extraction drift on the live path). Adds the `visitLimit`
// dimension (a VISIT/DAY COUNT cap, kept DISTINCT from a dollar annualLimitValue) + the multi-tier
// network-column rule, and CAPTURES per-service referral wording verbatim into coverageConditions.
// `referralRequired` is NOT decided by the LLM here — Option C (S241) derives it in code
// (deriveReferralRequired) from that verbatim text; the LLM's per-service referral guess was
// unreliable and is discarded.
const COVERAGE_DIMS_SUPPLEMENT = `

## ADDITIONAL FIELD — VISIT LIMITS (emit on EVERY service object)

In ADDITION to all fields above, add ONE field to each service:

- **visitLimit**: integer | null — a per-service VISIT or DAY COUNT cap (a COUNT, never a dollar amount):
    "20 visits per year", "limited to 12 visits", "30 visit maximum", "up to 60 days per admission",
    "100 days per year" → visitLimit = the COUNT (20, 12, 30, 60, 100).
    A DOLLAR cap ("$1,000 per year", "$500 benefit maximum", "up to $150") is NOT a visitLimit →
    leave visitLimit null and record the dollar cap in annualLimitValue (per rule L7).
    null → no visit/day-count limit stated for this service.
  ALWAYS copy the verbatim cap text into annualLimit (string) — e.g. "limited to 20 visits/year".
  visitLimit is the parsed COUNT; annualLimit is its VERBATIM SOURCE. A visitLimit with no verbatim cap
  text in annualLimit is dropped downstream, so never emit one without its exact wording.

## CAPTURE REFERRAL WORDING (verbatim only — do NOT decide a referral field)

Do NOT emit a referralRequired field. But if a service's OWN row/section contains referral wording —
"referral required" / "referral may be required" / "requires a referral" / "no referral" /
"self-referral" / "direct access" — copy that phrase VERBATIM into coverageConditions (alongside any
other conditions). The canonical seed derives the referral gate from this verbatim text in code; your
job is only to PRESERVE the wording, not to judge it. This adds no new output field and changes no cost field.

Example: { "serviceSlug": "pt_rehab", "visitLimit": 20, "annualLimit": "limited to 20 visits/year",
           "annualLimitValue": null, "coverageConditions": "Referral may be required.", ... }

## MULTI-TIER NETWORK COLUMNS — map in/out correctly (correctness for tiered plans)

Some plans list MORE THAN TWO network-tier columns under "What You Will Pay" — headers like
"Tier 1 Provider / Tier 2 Provider / Tier 3 Provider" or "Network | Out-of-Network". Identify the tiers
from the COLUMN HEADERS — do NOT count cost values (one column can hold several, e.g. "$5 copay first 2
visits, then $25 copay, $15 virtual" is ONE column, resolved by the standard-line rule above, NOT three
tiers). Then:
  - in* (inCopay / inCoinsurance / inDeductibleApplies) = the FIRST / best-network column ("Tier 1",
    "pay the least", "preferred", or "Network").
  - out* (outCopay / outCoinsurance / outDeductibleApplies) = the LAST / worst column (highest tier,
    "pay the most", or "Out-of-Network"). Example: "Tier 1: 30% / Tier 2: 40% / Tier 3: 60%" →
    inCoinsurance=30 and outCoinsurance=60 — NOT 40.
  - Any MIDDLE tier (e.g. Tier 2) cannot fit the two in/out fields — record it VERBATIM in
    coverageConditions (e.g. "Tier 2 provider: 40% coinsurance"); never let it become the in or out value.

## DO NOT CHANGE OTHER FIELDS (visitLimit is the only new output — orthogonality)

visitLimit is the ONLY new output field. Extract every OTHER field EXACTLY as you would WITHOUT this section:
- **priorAuthRequired**: keep its own rule unchanged (true/false only when the document states prior
  auth for the service; null when silent). This section does not change it — prior authorization and
  referral are SEPARATE gates, and capturing referral wording must not make you emit or flip priorAuthRequired.
- **inDeductibleApplies / outDeductibleApplies**: unchanged — do not re-read or re-decide these because
  of this section.
- **inCoinsurance / outCoinsurance / copays**: read them by your normal rules PLUS the multi-tier column
  rule above (which only clarifies which COLUMN is in vs out on tiered plans); the visit-limit and
  referral-capture steps must not otherwise shift them.
The ONLY intended interactions: (a) a per-visit/day COUNT you would previously have put in annualLimitValue
now goes to visitLimit instead (dollar caps stay in annualLimitValue); (b) referral wording is copied
verbatim into coverageConditions; (c) on multi-tier plans, in*/out* map to the first/last network column
per the rule above. Nothing else moves.`;

// S93 Stage 5a — supplements load from `parser_prompt_versions` (mig 102) at
// parse time with a 5-min in-process cache. The compile-time consts above are
// fallbacks when no active DB row exists (initial state pre-tuning) or when DB
// fetch fails. Admin tunes via /admin/parse-quality-tuning (Stage 5c) which
// writes a new active row + busts the cache.
// Exported (S251, cold-start regen Phase-0a): lets the seed harness snapshot the EXACT
// production extraction prompt to feed the Sonnet sub-agent (input+prompt parity). Export only —
// zero behavior change; the live pipeline calls it unchanged.
export async function buildInstructions(
  layout: PlanDocLayout | undefined,
  thesaurusEnabled: boolean,
  extractionV2Enabled: boolean,
  coverageDimsEnabled: boolean,
): Promise<string> {
  let prompt = BASE_INSTRUCTIONS;
  if (layout === "federal_sbc_8page" || layout === "federal_sbc_csr_variant") {
    prompt += await loadActiveSupplement(
      PROMPT_FILE_PATH,
      "FEDERAL_SBC_TABULAR_SUPPLEMENT",
      FEDERAL_SBC_TABULAR_SUPPLEMENT,
    );
  } else if (layout === "full_eoc_narrative") {
    prompt += await loadActiveSupplement(
      PROMPT_FILE_PATH,
      "FULL_EOC_NARRATIVE_SUPPLEMENT",
      FULL_EOC_NARRATIVE_SUPPLEMENT,
    );
  }
  // Thesaurus Phase 1a: append the service-identity fields ONLY when the flag is ON.
  // OFF → `prompt` is exactly BASE (+ layout supplement) as before = byte-identical.
  if (thesaurusEnabled) {
    prompt += THESAURUS_PHASE1A_SUPPLEMENT;
  }
  // Cold-start regen extraction v2 (S215): codified learnings appended LAST so they override.
  // OFF → byte-identical to the pre-v2 prompt.
  if (extractionV2Enabled) {
    prompt += EXTRACTION_V2_SUPPLEMENT;
  }
  // Coverage-dimensions (coverage_dims_v1): the distinct visit/day-count cap + multi-tier column rule,
  // plus verbatim capture of referral wording (referral is code-derived, not LLM-decided — Option C).
  // OFF → byte-identical (visitLimit is never requested; no referral-capture instruction is appended).
  if (coverageDimsEnabled) {
    prompt += COVERAGE_DIMS_SUPPLEMENT;
  }
  return prompt;
}

const BASE_INSTRUCTIONS = `You are extracting per-service cost-sharing from a Plan Document services section. Return a single JSON object listing every covered service with cost-sharing fields per service.

## CRITICAL EXTRACTION RULES

1. **Verbatim source_excerpt per service** (≤200 chars): a CONTIGUOUS substring of the section text that appears CHARACTER-FOR-CHARACTER in the source. NEVER paraphrase, summarize, reorder, or join non-contiguous pieces. Partial quotes are PERFECTLY ACCEPTABLE — you do NOT need to include both the service name and the cost values. Quote the MOST INFORMATIVE contiguous span ≤200 chars you can find verbatim. Quality over completeness.

**CORRECT** (any of these acceptable — pick the most informative contiguous span you can find verbatim):
- Just the costs: \`"$30 copay/visit"\` or \`"35% coinsurance"\`
- Just the service name line: \`"Primary Care Visit to treat an injury or illness"\`
- A multi-line span including the literal line breaks as they appear in source: \`"$30 copay/visit\\n40% coinsurance"\`
- A complete row ONLY if service name and costs literally appear adjacent in the source text: \`"Primary Care Visit: $30 copay/visit; 40% coinsurance"\`

**INCORRECT** (paraphrased — would fail verification):
> \`"Primary care office visits cost $30 copay in-network with 40% coinsurance out-of-network"\` (synthesized wording)

**INCORRECT** (joined non-contiguous pieces — would fail):
> \`"Primary Care ... $30 copay/visit ... 40% coinsurance"\` (ellipsis or text between costs that's not literally adjacent in source)

**INCORRECT** (added punctuation like pipes or colons that aren't in source):
> \`"Service: $30 | 40%"\` (if the source has these values on separate lines without pipes/colons added by you)

If you genuinely cannot find ANY contiguous verbatim span containing useful information for this service, set source_excerpt to "" (graceful 'not_found' state). Prefer SHORT but verifiable over LONG but synthesized.

2. **serviceSlug**: emit the canonical service slug from the curated 68-slug vocabulary below. For services that GENUINELY don't fit ANY canonical, emit \`proposed_<snake_case_descriptive_name>\` (e.g., \`proposed_hyperbaric_oxygen_therapy\`). NEVER invent bare snake_case slug names — either use a canonical OR use \`proposed_*\`.

### CANONICAL SERVICE SLUG VOCABULARY (68 slugs)

**office_visit (3)**: pcp_visit, specialist_visit, home_health
> Telehealth / virtual / online / scheduled-telephone visits, e-visits, and named virtual vendors (Teladoc, MDLive, Doctor on Demand, Amwell, etc.) are a PLACE, not a separate service. Emit the BASE service slug + \`placeOfService: virtual\`: \`pcp_visit\` (primary/general care), \`specialist_visit\` (medical specialist), or \`mental_health_outpatient\` (behavioral-health / therapy / psychiatry telehealth — NEVER specialist_visit). Do NOT emit telehealth_pcp or telehealth_specialist (deprecated).

**preventive (13)**: preventive_care, immunizations, annual_physical, cancer_screening, adult_dental_care, childrens_dental_checkup, childrens_eye_exam, childrens_glasses, routine_eye_care_adult, weight_loss_programs, vision_exam, vision_hardware, dental_orthodontic

**emergency (5)**: er_visit, urgent_care, emergency_transport_ground, emergency_transport_air, non_emergency_care_outside_us

**hospital (6)**: inpatient_facility, inpatient_physician, outpatient_surgery_facility, outpatient_surgery_physician, bariatric_surgery, cosmetic_surgery

**imaging (3)**: advanced_imaging, diagnostic_test, imaging_basic

**lab (1)**: lab_outpatient

**rx (9)**: generic_rx_tier1, generic_rx_tier1_90day, preferred_brand_rx_tier2, preferred_brand_rx_90day, non_preferred_rx_tier3, non_preferred_rx_90day, specialty_rx_tier4, preventive_rx, chemotherapy_rx

**therapy (9)**: pt_rehab, ot_rehab, speech_therapy, chiropractic, acupuncture, habilitation, nutritional_counseling, routine_foot_care, cardiac_rehab

**mental_health (4)**: mental_health_outpatient, mental_health_inpatient, substance_abuse_outpatient, substance_abuse_inpatient

**maternity (5)**: prenatal_visit, delivery_facility, delivery_professional, infertility_treatment, well_baby

**long_term_care (5)**: hospice_inpatient, hospice_outpatient, long_term_care, private_duty_nursing, skilled_nursing

**dme (2)**: durable_medical_equipment, hearing_aids

**other (1)**: childrens_dental

### SLUG SPLIT GUIDANCE (commonly seen as ONE row in source; emit as TWO rows when both facility and professional fees apply)

- Hospital "Outpatient Surgery" → emit BOTH \`outpatient_surgery_facility\` (facility fee) AND \`outpatient_surgery_physician\` (surgeon's professional fee). If source has separate columns/cost-shares, the split is empirically present.
- Hospital "Inpatient Stay" / "Hospital Stay" → emit BOTH \`inpatient_facility\` AND \`inpatient_physician\`.
- Maternity "Delivery" / "Childbirth" → emit BOTH \`delivery_facility\` AND \`delivery_professional\`.
- Hospice → choose \`hospice_inpatient\` or \`hospice_outpatient\` based on context. NEVER emit bare \`hospice\`.

### COMMON LEGACY NAME → CANONICAL MAPPING (apply silently)

- "Primary Care" / "primary_care" → \`pcp_visit\`
- "Emergency Room" / "emergency_room" → \`er_visit\`
- "Physical Therapy" / "physical_therapy" → \`pt_rehab\`
- "Occupational Therapy" / "occupational_therapy" → \`ot_rehab\`
- "Skilled Nursing Facility" / "skilled_nursing_facility" → \`skilled_nursing\`
- "Home Health Care" / "home_health_care" → \`home_health\`
- "Maternity Prenatal" / "maternity_prenatal" → \`prenatal_visit\`
- "Advanced Imaging" / "imaging_advanced" → \`advanced_imaging\`
- "Generic Drugs" / "generic_drugs" → \`generic_rx_tier1\`
- "Preferred Brand Drugs" / "preferred_brand_drugs" → \`preferred_brand_rx_tier2\`
- "Non-Preferred Drugs" / "non_preferred_brand_drugs" → \`non_preferred_rx_tier3\`
- "Specialty Drugs" / "specialty_drugs" → \`specialty_rx_tier4\`
- "Outpatient Mental Health" / "outpatient_mental_health" → \`mental_health_outpatient\`
- "Inpatient Mental Health" / "inpatient_mental_health" → \`mental_health_inpatient\`
- "Outpatient Substance Use" / "outpatient_substance_use" → \`substance_abuse_outpatient\`
- "Inpatient Substance Use" / "inpatient_substance_use" → \`substance_abuse_inpatient\`

### FEW-SHOT EXAMPLES (study these — they show the canonical mapping in practice)

**Example 1 — SBC tabular outpatient surgery (split into facility + professional)**

Source text:
\`\`\`
Outpatient surgery
Facility fee (e.g., ambulatory surgery center)
$300 copay/visit
45% coinsurance
Physician/surgeon fees
20% coinsurance
40% coinsurance
\`\`\`

Correct emission: TWO services
- { serviceSlug: "outpatient_surgery_facility", inCopay: 300, ..., source_excerpt: "$300 copay/visit", source_row_index: 2 }
- { serviceSlug: "outpatient_surgery_physician", inCoinsurance: 20, ..., source_excerpt: "20% coinsurance", source_row_index: 5 }

**Example 2 — SBC tabular advanced imaging (canonical mapping from legacy "imaging_advanced")**

Source text:
\`\`\`
Imaging (CT/PET scans, MRIs)
$0 copay/visit
50% coinsurance
\`\`\`

Correct emission: \`advanced_imaging\` (NOT \`imaging_advanced\`)

**Example 3 — EOC narrative section (no table; prose-style cost-sharing)**

Source text:
\`\`\`
We cover routine eye exams for adults once every 24 months. You pay 30% coinsurance after the deductible for an in-network optometrist. Out-of-network: 50% coinsurance after the deductible. Vision hardware (glasses or contacts) is covered up to $150 every 24 months.
\`\`\`

Correct emission: TWO services
- { serviceSlug: "routine_eye_care_adult", inCoinsurance: 30, outCoinsurance: 50, source_excerpt: "You pay 30% coinsurance after the deductible for an in-network optometrist", source_row_index: 1 }
- { serviceSlug: "vision_hardware", annualLimit: "$150 every 24 months", source_excerpt: "Vision hardware (glasses or contacts) is covered up to $150 every 24 months", source_row_index: 3 }

**Example 4 — genuinely-novel service triggers \`proposed_*\` namespace**

Source text:
\`\`\`
Hyperbaric oxygen therapy: 20% coinsurance, prior auth required.
\`\`\`

Correct emission: { serviceSlug: "proposed_hyperbaric_oxygen_therapy", inCoinsurance: 20, priorAuthRequired: true, ... }

(There is no canonical for hyperbaric oxygen therapy. Admin review will decide whether to promote.)

3. **Cost-sharing fields** (in/out network):
   - inCopay / outCopay: integer (USD) | null (null = not specified)
   - inCoinsurance / outCoinsurance: integer (percentage 0-100) | null
   - inDeductibleApplies / outDeductibleApplies: boolean | null
   - inCostDescription / outCostDescription: short verbatim cost-share text (e.g., "$30 copay" or "20% coinsurance after deductible")

4. **Out-of-network fields are MANDATORY when the document includes OON columns**. If document is HMO-only with no OON coverage, set out* fields to null AND outCostDescription to "Not covered". DO NOT default OON to in-network values.

5. **placeOfService**: MUST be one of the following canonical values (or "any" if unknown):
   - \`pcp_office\` — primary care visits, well-child visits
   - \`specialist_office\` — specialist visits, chiropractic, acupuncture
   - \`outpatient_facility\` — outpatient surgery, ambulatory care
   - \`inpatient_facility\` — hospital stays, inpatient surgery
   - \`independent_facility\` — independent imaging/lab centers
   - \`home\` — home health
   - \`virtual\` — telehealth visits
   - \`retail_pharmacy\` — retail Rx fills
   - \`home_delivery_pharmacy\` — mail-order Rx
   - \`designated_pharmacy\` — specialty pharmacy
   - \`any\` — when unknown or not applicable

   NEVER emit \`office\`, \`facility\`, or other free-form labels. If unsure, use \`any\`.

6. **howToAccess**: per-service plan-specific access instructions if the document includes them (e.g., "Prior auth required via 1-800-CIGNA-24" or "Find covered home health agency at mycigna.com/find-care"). null if not specified per service.

7. **priorAuthRequired**: boolean | null. Extract from Limitations/Notes column or per-service prior-auth callouts.

## RESPONSE SCHEMA

{
  "services": [
    {
      "serviceSlug": "pcp_visit",
      "placeOfService": "pcp_office",
      "inCopay": 30,
      "inCoinsurance": null,
      "inDeductibleApplies": false,
      "inCostDescription": "$30 copay per visit",
      "outCopay": null,
      "outCoinsurance": 40,
      "outDeductibleApplies": true,
      "outCostDescription": "40% coinsurance after deductible",
      "oonPaidAtInNetwork": false,
      "annualLimit": null,
      "annualLimitValue": null,
      "priorAuthRequired": false,
      "penaltyNoPrecert": null,
      "covered": true,
      "coverageConditions": null,
      "supplyLimitDays": null,
      "homeDeliveryCopay": null,
      "stepTherapyRequired": null,
      "notes": null,
      "howToAccess": "Find an in-network primary care provider at cigna.com/find-care",
      "source_excerpt": "verbatim ≤200 chars from the document section",
      "source_row_index": 12,
      "haiku_confidence": 0.92
    }
  ]
}

**source_row_index semantics**: 0-indexed line number of the first line in the source section where source_excerpt begins. For tabular SBC content, this is typically the line containing the service name OR the line containing the in-network cost-share. For EOC narrative, this is the line where the relevant sentence/paragraph starts. Provides traceability for the Pattern P-8 verbatim verifier + post-hoc validation count check (services count vs unique source_row_index count should be close).

## NOW EXTRACT FROM THIS DOCUMENT SECTION:`;

export interface RawService {
  serviceSlug?: string;
  placeOfService?: string;
  inCopay?: number | null;
  inCoinsurance?: number | null;
  inDeductibleApplies?: boolean | null;
  inCopayWaiverCondition?: string | null;
  inCostDescription?: string;
  outCopay?: number | null;
  outCoinsurance?: number | null;
  outDeductibleApplies?: boolean | null;
  outCostDescription?: string;
  oonPaidAtInNetwork?: boolean;
  annualLimit?: string | null;
  annualLimitValue?: number | null;
  priorAuthRequired?: boolean | null;
  penaltyNoPrecert?: number | null;
  // NB: no `referralRequired` here — the LLM is told (coverage_dims supplement) NOT to decide referral;
  // it only captures the wording verbatim into coverageConditions, and deriveReferralRequired decides.
  visitLimit?: number | null;
  covered?: boolean;
  coverageConditions?: string | null;
  supplyLimitDays?: number | null;
  homeDeliveryCopay?: number | null;
  stepTherapyRequired?: boolean | null;
  notes?: string | null;
  howToAccess?: string | null;
  source_excerpt?: string;
  source_row_index?: number | null;
  haiku_confidence?: number;
  rawLabel?: string | null;
  component?: string | null;
}

interface RawResponse {
  services?: RawService[];
}

// Thesaurus Phase 1a — normalize Haiku's `component` to the billing-grounded whitelist.
// Anything other than facility/professional defaults to 'global' (decision 6: default global
// only when genuinely ambiguous), so a bad/missing emission can never invent a split cell.
function normalizeComponent(v: unknown): "facility" | "professional" | "global" {
  return v === "facility" || v === "professional" ? v : "global";
}

/**
 * Extract per-service cost-sharing rows from a section's text.
 *
 * S73 (Session 76): accepts sectionHint param for parity with extractPlanIdentity +
 * extractAccessInstructions (multi-section dispatch consistency). For services, the
 * hint is always "services_cost_sharing" — services rows don't appear in other
 * sections by design. Default arg preserved for backward compat.
 *
 * Sub-segmentation: caller (parsePlanDocumentHaiku) splits the services section into
 * line-granularity chunks (max 1200 tokens each) and dispatches sequentially. Each
 * chunk's services array is concatenated + slug-deduped by the combine layer. Fixes
 * Kaiser-style 102+ services token-truncation (Haiku's 8K output budget cap).
 */
// coverage_dims_v1 (Option C, S241): referral is DERIVED in code, not guessed per-service by the LLM
// (the LLM per-service call over-extracted on broad-language plans + was stochastically unstable). A
// referral gates SEEING A SPECIALIST — never prior-auth / admission / visit-limits.
const CATEGORICAL_NO_REFERRAL = new Set([
  "pcp_visit", "preventive_care", "immunizations", "annual_physical", "er_visit", "urgent_care",
]);

/**
 * Derive the plan-level "Do you need a referral to see a specialist?" answer from the document text
 * (deterministic; calibration-independent — raw text scan, not a model call). The SBC "Important
 * Questions" field. Returns null when the document doesn't state it (-> per-service referral = null).
 */
export function derivePlanReferralPolicy(text: string): "yes" | "no" | null {
  const lc = text.toLowerCase().replace(/\s+/g, " ");
  const m = lc.match(/do (?:you|i) need a referral to see a\s+specialist\s*\?\s*(yes|no)\b/);
  if (m) return m[1] === "yes" ? "yes" : "no";
  // Distinctive answer phrases (robust to the bare Yes/No being OCR-split from the question).
  if (/see the specialist you choose without a referral|(?:do not|don'?t|does not|doesn'?t) (?:need|require) a referral|no referral (?:is )?(?:required|needed)/.test(lc)) return "no";
  if (/only if you have a referral|must have a referral|referral (?:is )?required|need a referral before you/.test(lc)) return "yes";
  return null;
}

// Requirement synonyms + an optional modal/aux run ("is/may/might/could/will/be"), shared by the
// per-service referral matcher so "referral may be required" reads the same as "referral required".
const REFERRAL_REQ = "(?:required|needed|necessary|mandatory)";
const REFERRAL_MODAL = "(?:\\s+(?:is|are|may|might|could|will|shall|be)){0,4}";
const RE_REFERRAL_NEG = new RegExp(`\\breferral\\b${REFERRAL_MODAL}\\s+(?:not|never)\\s+(?:be\\s+)?${REFERRAL_REQ}\\b`);
const RE_REFERRAL_WAIVED = /\breferral\b[^.]{0,25}\bwaived\b/;
const RE_REFERRAL_POS = new RegExp(`\\breferral\\b${REFERRAL_MODAL}\\s+${REFERRAL_REQ}\\b`);

/**
 * Classify an EXPLICIT per-service referral signal from the service's own verbatim text.
 * NEGATION is tested FIRST, so "referral may NOT be required" / "referral waived" can never fall
 * through to true. The positive branch accepts the conditional modal ("referral may be required") —
 * the verbatim conditional rides along in coverageConditions for display. Returns null when the text
 * is silent on referral (→ falls back to the categorical / pharmacy / plan-level rules below).
 */
export function explicitReferralSignal(svc: string): boolean | null {
  if (!/\breferral\b|\bdirect access\b/.test(svc)) return null;
  if (
    /\b(?:no|without(?:\s+a)?|self[-\s]?)\s*referral\b/.test(svc) ||
    /\bdirect\s+access\b/.test(svc) ||
    RE_REFERRAL_NEG.test(svc) ||
    RE_REFERRAL_WAIVED.test(svc) ||
    /\b(?:do|does)(?:\s+not|n['’]?t)\s+(?:need|require)\s+(?:a\s+)?referral\b/.test(svc)
  ) return false;
  if (
    RE_REFERRAL_POS.test(svc) ||
    /\brequires?\s+a\s+referral\b/.test(svc) ||
    /\bneeds?\s+a\s+referral\b/.test(svc) ||
    /\bpcp\s+referral\b/.test(svc)
  ) return true;
  return null;
}

/**
 * Fix A grounding (S250): an explicit per-service referral signal is trustworthy only when the OCR
 * actually carries referral wording NEAR this service's source anchor — mirrors verifyVisitLimit's
 * anchor-proximity. Kills the failure mode where the LLM copies a plan-level "Referral required" note
 * into a silent service's coverageConditions (an ungrounded true the per-service matcher would fire on).
 * Deterministic; no model call. Lenient when the anchor can't be located in the section (same fallback
 * verifyVisitLimit uses — a missing anchor never silently drops a genuine signal).
 */
export function verifyReferralGrounding(anchorExcerpt: string, sectionText: string): boolean {
  const hayLc = sectionText.replace(/\s+/g, " ").toLowerCase();
  const anchor = anchorExcerpt.replace(/\s+/g, " ").toLowerCase().slice(0, 50);
  const aIdx = anchor ? hayLc.indexOf(anchor) : -1;
  for (const m of hayLc.matchAll(/\breferral\b|\bdirect\s+access\b/gi)) {
    if (aIdx < 0 || Math.abs((m.index ?? 0) - aIdx) <= 400) return true;
  }
  return false;
}

/**
 * Derive a service's referralRequired DETERMINISTICALLY. Priority: GROUNDED explicit per-service text >
 * categorical-never-referred > pharmacy > plan-level answer (NO => false for all; YES => true for
 * specialist_visit ONLY, else null) > null. Replaces the unreliable LLM per-service guess (S241); the
 * grounding gate (Fix A, S250) keeps an LLM-copied plan-level note from forging a per-service signal.
 */
export function deriveReferralRequired(
  policy: "yes" | "no" | null,
  slug: string,
  textFields: unknown[],
  anchorExcerpt: string,
  sectionText: string,
): boolean | null {
  const svc = textFields.filter((x): x is string => typeof x === "string").join(" ").toLowerCase();
  // Only a referral signal grounded in the OCR near this service's anchor may decide; an ungrounded
  // copy falls through to the categorical / pharmacy / plan-level rules (→ conservative null on a YES plan).
  const explicit = explicitReferralSignal(svc);
  if (explicit !== null && verifyReferralGrounding(anchorExcerpt, sectionText)) return explicit;
  if (CATEGORICAL_NO_REFERRAL.has(slug)) return false;
  if (slug.includes("_rx")) return false; // drugs are prescribed, not referred
  if (policy === "no") return false;
  if (policy === "yes") return slug === "specialist_visit" ? true : null;
  return null;
}

// Verify an extracted visitLimit against the service's own source text: the count must appear with a
// visit/day UNIT in a LIMIT CONTEXT, near the service's source anchor. Returns the verbatim cap excerpt
// (cite-grade, §14 #5) when grounded, else null — dropping a "readmitted within 60 days" window mis-read
// as a cap, and counts that aren't in the document at all. Deterministic; no model call.
const VISIT_UNIT = "(?:visit|day|treatment|session|trip|night|exam|screening)s?";
const VISIT_CUE =
  "(?:limited to|up to|maximum|max\\b|\\blimit\\b|combined|allowance|per (?:year|member|benefit|visit|calendar)|/\\s*(?:year|visit)|benefit period|calendar year)";
const VISIT_NUM_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
// A count may be a digit or (for small caps) its word form — "One visit per year" grounds visitLimit=1.
function visitCountAlt(n: number): string {
  const alts = [String(n)];
  if (n < VISIT_NUM_WORDS.length) alts.push(VISIT_NUM_WORDS[n]);
  if (n === 1) alts.push("once");
  if (n === 2) alts.push("twice");
  return `(?:${alts.join("|")})`;
}

export function verifyVisitLimit(
  count: number,
  capText: string | null,
  anchorExcerpt: string,
  sectionText: string,
): string | null {
  if (!Number.isInteger(count) || count <= 0) return null;
  const hay = sectionText.replace(/\s+/g, " ");
  const hayLc = hay.toLowerCase();
  // count (digit or word) tied to a visit/day unit, tolerating up to 2 NON-cost words between
  // ("30 rehab visits") — excluding copay/coinsurance/deductible/per so "$35 Copay per Visit" (a rate,
  // not a count) can never masquerade as "35 visits".
  const filler = "(?:[\\s-]+(?!(?:copay|coinsurance|deductible|per)\\b)\\w+){0,2}";
  const countUnit = `\\b${visitCountAlt(count)}\\b${filler}[\\s-]*${VISIT_UNIT}`;
  // (1) LLM-cited: count+unit present in the captured cap text AND that text is verbatim-in-source —
  // trust it (the §14 cite-grade self-citation; robust to OCR scatter + adjectives + word-numbers).
  if (capText) {
    const cap = capText.replace(/\s+/g, " ").trim();
    if (cap && new RegExp(countUnit, "i").test(cap) && hayLc.includes(cap.toLowerCase().slice(0, 40))) return cap;
  }
  // (2) uncited (blank annualLimit): count+unit within a LIMIT context near the service — this is where
  // a "readmitted within 60 days" window and counts absent from the document get dropped.
  const re = new RegExp(`(?:${VISIT_CUE}[^.]{0,30}${countUnit}|${countUnit}[^.]{0,30}${VISIT_CUE})`, "gi");
  const anchor = anchorExcerpt.replace(/\s+/g, " ").toLowerCase().slice(0, 50);
  const aIdx = anchor ? hayLc.indexOf(anchor) : -1;
  for (const m of hay.matchAll(re)) {
    if (aIdx < 0 || Math.abs((m.index ?? 0) - aIdx) <= 400) return hay.slice(m.index, (m.index ?? 0) + 90).trim();
  }
  return null;
}

export async function extractServicesCostSharing(
  sectionText: string,
  sectionRange: { start: number; end: number },
  extractionMethod: ExtractionMethod,
  sectionHint: PlanDocSectionHint = "services_cost_sharing",
  layout?: PlanDocLayout,
  // Test/dry-run override for `thesaurus_phase1a_v1`. PROD leaves it undefined → reads the
  // live flag (OFF → byte-identical). The calibration harness passes `true` to measure the
  // flag-ON before/after without depending on DB flag state (calibration independence).
  thesaurusPhase1aOverride?: boolean,
  // Test/dry-run override for `plan_doc_extraction_v2`. PROD callers resolve it in the orchestrator
  // (parser.ts) and pass it down so the prompt-supplement gate and the whole-text fallback gate stay
  // in lockstep; undefined → read the live flag (OFF → byte-identical).
  extractionV2Override?: boolean,
  // Test/dry-run override for `coverage_dims_v1` (per-service referral + visit/day-count cap).
  // PROD leaves it undefined → reads the live flag (OFF → byte-identical). The §13 oracle harness
  // passes `true` to measure flag-ON without depending on DB flag state (calibration independence).
  coverageDimsOverride?: boolean,
  // S253 cold-start regen Stage C: inject the Sonnet sub-agent's cached raw services — SKIP the LLM and
  // run the SAME post-processors (referral/visit/cite-grade) on the override. undefined → normal LLM path
  // (byte-identical). The caller passes the RAW text-cache as `sectionText` so the cached excerpts ground
  // verbatim (the exact text the sub-agent saw).
  rawServicesOverride?: RawService[],
): Promise<PlanDocSectionResult<{ services: PlanDocService[] }>> {
  const thesaurusEnabled =
    thesaurusPhase1aOverride ?? (await isFeatureEnabled("thesaurus_phase1a_v1"));
  const extractionV2Enabled =
    extractionV2Override ?? (await isFeatureEnabled("plan_doc_extraction_v2"));
  const coverageDimsEnabled =
    coverageDimsOverride ?? (await isFeatureEnabled("coverage_dims_v1"));
  // S253 cold-start regen Stage C: when a cached extraction is injected, SKIP the LLM (no prompt build,
  // no DB read, no API call) and feed the override into the SAME post-processors below — deterministic.
  const result =
    rawServicesOverride !== undefined
      ? {
          data: { services: rawServicesOverride } as RawResponse,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          cacheCreateTokens: 0,
          cacheReadTokens: 0,
          warnings: [`seed_override:${rawServicesOverride.length}_raw_services`],
        }
      : await callHaikuWithCache<RawResponse>({
          systemPrompt:
            HAIKU_CACHE_PAD +
            (await buildInstructions(layout, thesaurusEnabled, extractionV2Enabled, coverageDimsEnabled)),
          userContent: sectionText,
          sectionLabel:
            layout === "federal_sbc_8page" || layout === "federal_sbc_csr_variant"
              ? "services_cost_sharing_federal_sbc"
              : "services_cost_sharing",
        });

  // coverage_dims_v1 (Option C): plan-level referral answer derived ONCE from the document text;
  // each service's referralRequired is then a deterministic function of (policy × slug × explicit text).
  const referralPolicy = coverageDimsEnabled ? derivePlanReferralPolicy(sectionText) : null;
  const services: PlanDocService[] = (result.data.services ?? [])
    .map((raw): PlanDocService | null => {
      const slug = typeof raw.serviceSlug === "string" ? raw.serviceSlug.trim() : null;
      if (!slug) return null;
      const sourceExcerpt = typeof raw.source_excerpt === "string" ? raw.source_excerpt.slice(0, 200) : "";
      const patternP8: PlanDocPatternP8Provenance = {
        source_excerpt: sourceExcerpt,
        source_excerpt_verified: "not_found",
        source_excerpt_extraction_method: extractionMethod,
        source_section_hint: sectionHint,
        source_section_verified: false,
      };
      const sourceRowIndex =
        typeof raw.source_row_index === "number" && Number.isFinite(raw.source_row_index)
          ? Math.max(0, Math.floor(raw.source_row_index))
          : null;
      // coverage_dims_v1: verify the LLM's visitLimit against the source (count+unit in a LIMIT context
      // near this service) — unverified counts are hallucinations/misextractions and get dropped; the
      // located verbatim cap becomes the cite-grade excerpt (§14 #5) + backfills a blank annualLimit.
      const baseAnnual = typeof raw.annualLimit === "string" ? raw.annualLimit : null;
      const visitExcerpt =
        coverageDimsEnabled && typeof raw.visitLimit === "number"
          ? verifyVisitLimit(raw.visitLimit, baseAnnual, sourceExcerpt, sectionText)
          : null;
      const annualLimit =
        coverageDimsEnabled && visitExcerpt && (!baseAnnual || !baseAnnual.trim())
          ? visitExcerpt
          : baseAnnual;
      return {
        serviceSlug: slug,
        placeOfService: typeof raw.placeOfService === "string" ? raw.placeOfService : "",
        inCopay: typeof raw.inCopay === "number" ? raw.inCopay : null,
        inCoinsurance: typeof raw.inCoinsurance === "number" ? raw.inCoinsurance : null,
        inDeductibleApplies: typeof raw.inDeductibleApplies === "boolean" ? raw.inDeductibleApplies : null,
        inCopayWaiverCondition: typeof raw.inCopayWaiverCondition === "string" ? raw.inCopayWaiverCondition : null,
        inCostDescription: typeof raw.inCostDescription === "string" ? raw.inCostDescription : "",
        outCopay: typeof raw.outCopay === "number" ? raw.outCopay : null,
        outCoinsurance: typeof raw.outCoinsurance === "number" ? raw.outCoinsurance : null,
        outDeductibleApplies: typeof raw.outDeductibleApplies === "boolean" ? raw.outDeductibleApplies : null,
        outCostDescription: typeof raw.outCostDescription === "string" ? raw.outCostDescription : "",
        oonPaidAtInNetwork: raw.oonPaidAtInNetwork === true,
        annualLimit,
        annualLimitValue: typeof raw.annualLimitValue === "number" ? raw.annualLimitValue : null,
        priorAuthRequired: typeof raw.priorAuthRequired === "boolean" ? raw.priorAuthRequired : null,
        penaltyNoPrecert: typeof raw.penaltyNoPrecert === "number" ? raw.penaltyNoPrecert : null,
        // coverage_dims_v1: populated ONLY when ON; OFF → undefined (Haiku wasn't asked for them
        // → struct is byte-identical to pre-flag). Mirrors the rawLabel/component gating below.
        // Option C (S241): code-derived, not raw.referralRequired (LLM no longer decides referral).
        referralRequired: coverageDimsEnabled
          ? deriveReferralRequired(referralPolicy, slug, [
              raw.coverageConditions, raw.source_excerpt, raw.inCostDescription, raw.notes,
            ], sourceExcerpt, sectionText)
          : undefined,
        visitLimit: coverageDimsEnabled
          ? (typeof raw.visitLimit === "number" && visitExcerpt ? raw.visitLimit : null)
          : undefined,
        covered: raw.covered !== false,
        coverageConditions: typeof raw.coverageConditions === "string" ? raw.coverageConditions : null,
        supplyLimitDays: typeof raw.supplyLimitDays === "number" ? raw.supplyLimitDays : null,
        homeDeliveryCopay: typeof raw.homeDeliveryCopay === "number" ? raw.homeDeliveryCopay : null,
        stepTherapyRequired: typeof raw.stepTherapyRequired === "boolean" ? raw.stepTherapyRequired : null,
        notes: typeof raw.notes === "string" ? raw.notes : null,
        confidence: typeof raw.haiku_confidence === "number" ? raw.haiku_confidence : 0.5,
        sourceExcerpt: sourceExcerpt || null,
        sourcePage: null,
        howToAccess:
          typeof raw.howToAccess === "string" && raw.howToAccess.length > 0 ? raw.howToAccess : null,
        patternP8,
        haikuConfidence: typeof raw.haiku_confidence === "number" ? raw.haiku_confidence : undefined,
        sourceRowIndex,
        // Thesaurus Phase 1a: populated ONLY when ON; OFF → undefined (Haiku wasn't asked for
        // them → struct is byte-identical to pre-Phase-1a).
        rawLabel: thesaurusEnabled
          ? typeof raw.rawLabel === "string" && raw.rawLabel.trim().length > 0
            ? raw.rawLabel.trim().slice(0, 120)
            : null
          : undefined,
        component: thesaurusEnabled ? normalizeComponent(raw.component) : undefined,
      };
    })
    .filter((s): s is PlanDocService => s !== null);

  return {
    section_type: "services_cost_sharing",
    section_range: sectionRange,
    data: { services },
    haiku_input_tokens: result.inputTokens,
    haiku_output_tokens: result.outputTokens,
    haiku_cost_usd: result.costUsd,
    haiku_cache_create_tokens: result.cacheCreateTokens ?? 0,
    haiku_cache_read_tokens: result.cacheReadTokens ?? 0,
    warnings: result.warnings,
  };
}
