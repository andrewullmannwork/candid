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

// S93 Stage 5a — supplements load from `parser_prompt_versions` (mig 102) at
// parse time with a 5-min in-process cache. The compile-time consts above are
// fallbacks when no active DB row exists (initial state pre-tuning) or when DB
// fetch fails. Admin tunes via /admin/parse-quality-tuning (Stage 5c) which
// writes a new active row + busts the cache.
async function buildInstructions(
  layout: PlanDocLayout | undefined,
  thesaurusEnabled: boolean,
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

**office_visit (5)**: pcp_visit, specialist_visit, home_health, telehealth_pcp, telehealth_specialist

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

interface RawService {
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
): Promise<PlanDocSectionResult<{ services: PlanDocService[] }>> {
  const thesaurusEnabled =
    thesaurusPhase1aOverride ?? (await isFeatureEnabled("thesaurus_phase1a_v1"));
  const systemPrompt = await buildInstructions(layout, thesaurusEnabled);
  const result = await callHaikuWithCache<RawResponse>({
    systemPrompt: HAIKU_CACHE_PAD + systemPrompt,
    userContent: sectionText,
    sectionLabel:
      layout === "federal_sbc_8page" || layout === "federal_sbc_csr_variant"
        ? "services_cost_sharing_federal_sbc"
        : "services_cost_sharing",
  });

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
        annualLimit: typeof raw.annualLimit === "string" ? raw.annualLimit : null,
        annualLimitValue: typeof raw.annualLimitValue === "number" ? raw.annualLimitValue : null,
        priorAuthRequired: typeof raw.priorAuthRequired === "boolean" ? raw.priorAuthRequired : null,
        penaltyNoPrecert: typeof raw.penaltyNoPrecert === "number" ? raw.penaltyNoPrecert : null,
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
