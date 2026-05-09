// Plan Document Parser — extracts structured plan data from full plan certificate OCR text
// Plan certificates (e.g., Cigna "Plan Benefits" documents) have a completely different
// format from SBCs. They use "The Schedule" sections with "Calendar Year Deductible",
// "$X per person", service copays like "$20 per visit copay, then 100%", and full
// ERISA/COBRA details. This parser is designed to be flexible across insurer formats.

import type { InsurancePlanInsert, PlanCoveredServiceInsert } from "@/lib/supabase/types";
import type { SBCParseResult, SBCParsedService } from "@/lib/sbc/types";
import type { ExtractionMethod } from "@/lib/parser/types";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import { parsePlanDocumentHaiku } from "@/lib/plan_doc/parser";
import { toLegacyPlanDocResult } from "@/lib/plan_doc/legacy-adapter";

// Re-export the same result type for consistency
export type PlanDocParseResult = SBCParseResult;

// ── Public dispatcher: flag-gated between legacy regex + Haiku-first (S72) ──

export interface ParsePlanDocumentOptions {
  documentId?: string;
  extractionMethod?: ExtractionMethod;
}

/**
 * Plan-document parser dispatcher.
 *
 * Flag-gated between legacy regex (`parsePlanDocumentRegex`, ~49% recall) and
 * Haiku-first (`parsePlanDocumentHaiku` per Phase 3.1A architectural template,
 * ~80%+ recall on per-section dispatch) via `plan_doc_parser_v2` flag (mig 083).
 *
 * Per Q-S72-2 (b) LOCK (Subplan §2): when flag ON, EOC parser plan-identity
 * reuse at eoc/parser.ts also routes through Haiku-first (free recall lift).
 * Mitigation: Blue Shield Silver 70 PPO EOC fixture regression check mid-S72
 * per Subplan §5.
 *
 * `opts.documentId` + `opts.extractionMethod` are used only on the Haiku-first
 * path (legacy regex doesn't need them). Defaults preserve backward-compat for
 * any caller that doesn't yet pass options.
 */
export async function parsePlanDocument(
  ocrText: string,
  opts?: ParsePlanDocumentOptions,
): Promise<PlanDocParseResult> {
  const flagEnabled = await isFeatureEnabled("plan_doc_parser_v2");
  if (flagEnabled) {
    const haikuResult = await parsePlanDocumentHaiku({
      ocrText,
      extractionMethod: opts?.extractionMethod ?? "pdftotext",
      documentId: opts?.documentId ?? "unknown",
    });
    return toLegacyPlanDocResult(haikuResult);
  }
  return parsePlanDocumentRegex(ocrText);
}

// ── Non-service terms blocklist ────────────────────────────────────────────
// These are section headers, column labels, and plan structure terms that the
// backward service-name scanner incorrectly picks up as service names.
const NON_SERVICE_TERMS = new Set([
  "calendar year maximum",
  "calendar year deductible",
  "benefit highlights",
  "the schedule",
  "plan deductible",
  "out-of-pocket",
  "out of pocket",
  "out-of-pocket maximum",
  "family maximum",
  "individual calculation",
  "aggregate calculation",
  "lifetime maximum",
  "benefit period",
  "plan year",
  "effective date",
  "coverage period",
  "in-network",
  "out-of-network",
  "participating provider",
  "non-participating provider",
  "preferred provider",
  "annual maximum",
  "unlimited",
  "not applicable",
  "combined medical",
  "precertification",
  "preauthorization",
  "coordination of benefits",
  "covered expenses",
  "benefit highlights",
  "how the plan works",
  "important notice",
  "general provisions",
  "plan administration",
  "summary of benefits",
  "table of contents",
  "your cost sharing",
  "cost sharing",
  "maximum benefit",
  "benefit maximum",
  "replacement due to regular wear",
  "each qualified beneficiary",
  "your employer may charge",
  "the amount you pay",
  "total premium",
  "the cost to the group health plan",
]);

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseDollar(text: string): number | null {
  const m = text.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
  return m ? parseFloat(m[1].replace(/,/g, "")) : null;
}

function parsePercent(text: string): number | null {
  const m = text.match(/(\d+)\s*%/);
  return m ? parseInt(m[1], 10) / 100 : null;
}

function firstMatch(text: string, patterns: RegExp[]): RegExpMatchArray | null {
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m;
  }
  return null;
}

// ── Cost description parser ─────────────────────────────────────────────────
// Parses strings like "$20 per visit copay, then 100%" or "Plan deductible, then 90%"
function parseCostDescription(desc: string): {
  copay: number | null;
  coinsurance: number | null;
  deductibleApplies: boolean;
  copayWaiverCondition: string | null;
} {
  const copay = parseDollar(desc);
  const deductibleApplies = /deductible/i.test(desc);

  // Coinsurance: "then 90%" means plan pays 90%, user pays 10%
  const coinMatch = desc.match(/then\s+(\d+)\s*%/i);
  let coinsurance: number | null = null;
  if (coinMatch) {
    const planPays = parseInt(coinMatch[1], 10);
    if (planPays < 100) {
      coinsurance = (100 - planPays) / 100; // Convert plan-pays to user-pays
    }
  }

  // "100%" with no copay = fully covered
  if (/^\s*100\s*%\s*$/.test(desc.trim()) || desc.trim() === "100%") {
    coinsurance = 0;
  }

  // Waiver conditions: "waived if admitted"
  const waiverMatch = desc.match(/\(waived\s+if\s+([^)]+)\)/i);
  const copayWaiverCondition = waiverMatch ? waiverMatch[1].trim() : null;

  return { copay, coinsurance, deductibleApplies, copayWaiverCondition };
}

// ── Service mapping ─────────────────────────────────────────────────────────
// Maps plan doc service names to service_catalog slugs
const SERVICE_NAME_MAP: Record<string, { slug: string; place: string }[]> = {
  // ── Office visits ───────────────────────────────────────────────────────
  "primary care physician's office visit": [{ slug: "pcp_visit", place: "pcp_office" }],
  "primary care physician's office": [{ slug: "pcp_visit", place: "pcp_office" }],
  "primary care physician": [{ slug: "pcp_visit", place: "pcp_office" }],
  "physician's services": [{ slug: "pcp_visit", place: "pcp_office" }],
  "office visit": [{ slug: "pcp_visit", place: "pcp_office" }],
  "primary care physician virtual office visit": [{ slug: "telehealth", place: "virtual" }],
  "specialty care physician's office visit": [{ slug: "specialist_visit", place: "specialist_office" }],
  "specialty care physician's office": [{ slug: "specialist_visit", place: "specialist_office" }],
  "specialty care physician virtual office visit": [{ slug: "telehealth_specialist", place: "virtual" }],
  "consultant and referral physician's services": [{ slug: "specialist_visit", place: "specialist_office" }],
  "second opinion": [{ slug: "second_opinion", place: "specialist_office" }],
  "annual physical": [{ slug: "annual_physical", place: "pcp_office" }],
  "well child visit": [{ slug: "well_child_visit", place: "pcp_office" }],
  "well-child visit": [{ slug: "well_child_visit", place: "pcp_office" }],
  "well child care": [{ slug: "well_child_visit", place: "pcp_office" }],
  // ── Emergency / Urgent ──────────────────────────────────────────────────
  "hospital emergency room": [{ slug: "er_visit", place: "emergency" }],
  "emergency services": [{ slug: "er_visit", place: "emergency" }],
  "emergency room": [{ slug: "er_visit", place: "emergency" }],
  "urgent care facility": [{ slug: "urgent_care", place: "outpatient_facility" }],
  "urgent care": [{ slug: "urgent_care", place: "outpatient_facility" }],
  "convenience care clinic": [{ slug: "urgent_care", place: "pcp_office" }],
  "air ambulance": [{ slug: "air_ambulance", place: "any" }],
  "ambulance": [{ slug: "ambulance", place: "any" }],
  "ground ambulance": [{ slug: "ambulance", place: "any" }],
  // ── Hospital / Facility ─────────────────────────────────────────────────
  "inpatient hospital": [{ slug: "inpatient_hospital", place: "inpatient_facility" }],
  "inpatient facility": [{ slug: "inpatient_hospital", place: "inpatient_facility" }],
  "semi-private room and board": [{ slug: "inpatient_hospital", place: "inpatient_facility" }],
  "inpatient physician": [{ slug: "inpatient_physician", place: "inpatient_facility" }],
  "outpatient facility services": [{ slug: "outpatient_surgery", place: "outpatient_facility" }],
  "outpatient hospital facility": [{ slug: "outpatient_surgery", place: "outpatient_facility" }],
  "outpatient surgery": [{ slug: "outpatient_surgery", place: "outpatient_facility" }],
  "ambulatory surgical center": [{ slug: "outpatient_surgery", place: "outpatient_facility" }],
  "skilled nursing facility": [{ slug: "skilled_nursing", place: "inpatient_facility" }],
  "skilled nursing": [{ slug: "skilled_nursing", place: "inpatient_facility" }],
  // ── Preventive ──────────────────────────────────────────────────────────
  "routine preventive care": [{ slug: "preventive_care", place: "any" }],
  "preventive care": [{ slug: "preventive_care", place: "any" }],
  "preventive services": [{ slug: "preventive_care", place: "any" }],
  "immunizations": [{ slug: "immunizations", place: "any" }],
  "vaccinations": [{ slug: "immunizations", place: "any" }],
  "mammograms": [{ slug: "mammogram", place: "any" }],
  "mammography": [{ slug: "mammogram", place: "any" }],
  "cancer screening": [{ slug: "cancer_screening", place: "any" }],
  "colorectal cancer screening": [{ slug: "cancer_screening", place: "any" }],
  "cervical cancer screening": [{ slug: "cancer_screening", place: "any" }],
  "pap smear": [{ slug: "cancer_screening", place: "any" }],
  "prostate screening": [{ slug: "cancer_screening", place: "any" }],
  // ── Therapy / Rehab ─────────────────────────────────────────────────────
  "physical therapy": [{ slug: "physical_therapy", place: "any" }],
  "speech therapy": [{ slug: "speech_therapy", place: "any" }],
  "occupational therapy": [{ slug: "occupational_therapy", place: "any" }],
  "chiropractic": [{ slug: "chiropractic", place: "specialist_office" }],
  "chiropractic care": [{ slug: "chiropractic", place: "specialist_office" }],
  "cardiac rehabilitation": [{ slug: "cardiac_rehab", place: "any" }],
  "outpatient cardiac rehabilitation": [{ slug: "cardiac_rehab", place: "any" }],
  "pulmonary rehabilitation": [{ slug: "pulmonary_rehab", place: "any" }],
  "pulmonary therapy": [{ slug: "pulmonary_rehab", place: "any" }],
  "cognitive therapy": [{ slug: "cognitive_therapy", place: "any" }],
  "cognitive behavioral therapy": [{ slug: "cognitive_therapy", place: "any" }],
  "habilitation": [{ slug: "habilitation", place: "any" }],
  "habilitative services": [{ slug: "habilitation", place: "any" }],
  "acupuncture": [{ slug: "acupuncture", place: "specialist_office" }],
  "applied behavior analysis": [{ slug: "aba_therapy", place: "any" }],
  "aba therapy": [{ slug: "aba_therapy", place: "any" }],
  // ── Mental Health ───────────────────────────────────────────────────────
  "mental health": [{ slug: "mental_health_outpatient", place: "any" }],
  "mental health outpatient": [{ slug: "mental_health_outpatient", place: "any" }],
  "mental health inpatient": [{ slug: "mental_health_inpatient", place: "inpatient_facility" }],
  "inpatient mental health": [{ slug: "mental_health_inpatient", place: "inpatient_facility" }],
  "partial hospitalization": [{ slug: "mental_health_partial", place: "outpatient_facility" }],
  "intensive outpatient": [{ slug: "mental_health_iop", place: "outpatient_facility" }],
  "substance use disorder": [{ slug: "substance_abuse_outpatient", place: "any" }],
  "substance abuse": [{ slug: "substance_abuse_outpatient", place: "any" }],
  "substance abuse inpatient": [{ slug: "substance_abuse_inpatient", place: "inpatient_facility" }],
  "chemical dependency": [{ slug: "substance_abuse_outpatient", place: "any" }],
  "behavioral health": [{ slug: "mental_health_outpatient", place: "any" }],
  // ── Maternity ───────────────────────────────────────────────────────────
  "maternity": [{ slug: "maternity_delivery", place: "inpatient_facility" }],
  "prenatal care": [{ slug: "maternity_prenatal", place: "any" }],
  "prenatal visit": [{ slug: "maternity_prenatal", place: "any" }],
  "postnatal care": [{ slug: "maternity_postnatal", place: "any" }],
  "delivery": [{ slug: "maternity_delivery", place: "inpatient_facility" }],
  "delivery and newborn": [{ slug: "maternity_delivery", place: "inpatient_facility" }],
  "newborn care": [{ slug: "newborn_care", place: "inpatient_facility" }],
  // ── Lab / Imaging ───────────────────────────────────────────────────────
  "laboratory services": [{ slug: "lab_work", place: "any" }],
  "laboratory": [{ slug: "lab_work", place: "any" }],
  "lab services": [{ slug: "lab_work", place: "any" }],
  "diagnostic lab": [{ slug: "lab_work", place: "any" }],
  "pathology": [{ slug: "lab_work", place: "any" }],
  "blood work": [{ slug: "lab_work", place: "any" }],
  "radiology services": [{ slug: "imaging_xray", place: "any" }],
  "radiology": [{ slug: "imaging_xray", place: "any" }],
  "x-ray": [{ slug: "imaging_xray", place: "any" }],
  "diagnostic x-ray": [{ slug: "imaging_xray", place: "any" }],
  "advanced radiological imaging": [{ slug: "imaging_advanced", place: "any" }],
  "advanced imaging": [{ slug: "imaging_advanced", place: "any" }],
  "mri": [{ slug: "imaging_advanced", place: "any" }],
  "cat scan": [{ slug: "imaging_advanced", place: "any" }],
  "ct scan": [{ slug: "imaging_advanced", place: "any" }],
  "pet scan": [{ slug: "imaging_advanced", place: "any" }],
  "diagnostic testing": [{ slug: "diagnostic_test", place: "any" }],
  "diagnostic test": [{ slug: "diagnostic_test", place: "any" }],
  // ── DME / Prosthetics ───────────────────────────────────────────────────
  "durable medical equipment": [{ slug: "dme", place: "home" }],
  "prosthetic devices": [{ slug: "prosthetics", place: "any" }],
  "prosthetics": [{ slug: "prosthetics", place: "any" }],
  "orthotic devices": [{ slug: "orthotics", place: "any" }],
  "hearing aids": [{ slug: "hearing_aids", place: "any" }],
  "cochlear implant": [{ slug: "hearing_aids", place: "any" }],
  // ── Other Services ──────────────────────────────────────────────────────
  "hospice": [{ slug: "hospice", place: "any" }],
  "hospice care": [{ slug: "hospice", place: "any" }],
  "home health care": [{ slug: "home_health", place: "home" }],
  "home health": [{ slug: "home_health", place: "home" }],
  "organ transplant": [{ slug: "organ_transplant", place: "inpatient_facility" }],
  "transplant": [{ slug: "organ_transplant", place: "inpatient_facility" }],
  "allergy testing": [{ slug: "allergy_treatment", place: "specialist_office" }],
  "allergy treatment": [{ slug: "allergy_treatment", place: "specialist_office" }],
  "allergy serum": [{ slug: "allergy_treatment", place: "specialist_office" }],
  "allergy injections": [{ slug: "allergy_treatment", place: "specialist_office" }],
  "nutritional counseling": [{ slug: "nutritional_counseling", place: "any" }],
  "nutrition counseling": [{ slug: "nutritional_counseling", place: "any" }],
  "dietitian": [{ slug: "nutritional_counseling", place: "any" }],
  "genetic counseling": [{ slug: "genetic_counseling", place: "any" }],
  "genetic testing": [{ slug: "genetic_testing", place: "any" }],
  "dialysis": [{ slug: "dialysis", place: "outpatient_facility" }],
  "kidney dialysis": [{ slug: "dialysis", place: "outpatient_facility" }],
  "bariatric surgery": [{ slug: "bariatric_surgery", place: "inpatient_facility" }],
  "weight loss surgery": [{ slug: "bariatric_surgery", place: "inpatient_facility" }],
  "infertility": [{ slug: "infertility_treatment", place: "specialist_office" }],
  "fertility treatment": [{ slug: "infertility_treatment", place: "specialist_office" }],
  "sterilization": [{ slug: "sterilization", place: "outpatient_facility" }],
  "temporomandibular joint": [{ slug: "tmj_treatment", place: "specialist_office" }],
  "tmj": [{ slug: "tmj_treatment", place: "specialist_office" }],
  "sleep study": [{ slug: "sleep_study", place: "outpatient_facility" }],
  "sleep disorder": [{ slug: "sleep_study", place: "outpatient_facility" }],
  "dental accident": [{ slug: "dental_injury", place: "any" }],
  "dental injury": [{ slug: "dental_injury", place: "any" }],
  "children's dental": [{ slug: "childrens_dental", place: "any" }],
  "pediatric dental": [{ slug: "childrens_dental", place: "any" }],
  "children's eye exam": [{ slug: "childrens_eye_exam", place: "any" }],
  "pediatric vision": [{ slug: "childrens_eye_exam", place: "any" }],
  "children's glasses": [{ slug: "childrens_glasses", place: "any" }],
  "vision exam": [{ slug: "vision_exam", place: "specialist_office" }],
  "eye exam": [{ slug: "vision_exam", place: "specialist_office" }],
  "bereavement counseling": [{ slug: "bereavement_counseling", place: "any" }],
  "medical pharmaceuticals": [{ slug: "medical_pharmaceuticals", place: "any" }],
  "other medical pharmaceuticals": [{ slug: "medical_pharmaceuticals", place: "any" }],
  "cigna pathwell specialty": [{ slug: "specialty_rx", place: "any" }],
  "dedicated virtual": [{ slug: "telehealth", place: "virtual" }],
  // ── Additional mappings for Cigna format ───────────────────────────────
  "spinal manipulation": [{ slug: "chiropractic", place: "specialist_office" }],
  "subluxation": [{ slug: "chiropractic", place: "specialist_office" }],
  "external prosthetic": [{ slug: "prosthetics", place: "any" }],
  "diabetic equipment": [{ slug: "dme", place: "home" }],
  "rehabilitation hospital": [{ slug: "skilled_nursing", place: "inpatient_facility" }],
  "sub-acute": [{ slug: "skilled_nursing", place: "inpatient_facility" }],
  "inpatient services at other health care facilities": [{ slug: "skilled_nursing", place: "inpatient_facility" }],
  "substance use disorder inpatient": [{ slug: "substance_abuse_inpatient", place: "inpatient_facility" }],
  "substance use disorder outpatient": [{ slug: "substance_abuse_outpatient", place: "any" }],
  "outpatient therapy services": [{ slug: "physical_therapy", place: "any" }],
  "women's surgical sterilization": [{ slug: "sterilization", place: "outpatient_facility" }],
  "advanced cellular therapy": [{ slug: "organ_transplant", place: "inpatient_facility" }],
  "independent lab": [{ slug: "lab_work", place: "outpatient_facility" }],
  "inpatient hospital physician": [{ slug: "inpatient_physician", place: "inpatient_facility" }],
  "preventive care related": [{ slug: "preventive_care", place: "any" }],
  "home setting": [{ slug: "home_health", place: "home" }],
  "inpatient services": [{ slug: "inpatient_hospital", place: "inpatient_facility" }],
  "outpatient hospital": [{ slug: "outpatient_surgery", place: "outpatient_facility" }],
  "outpatient - office visits": [{ slug: "mental_health_outpatient", place: "specialist_office" }],
  "outpatient - all other services": [{ slug: "mental_health_outpatient", place: "outpatient_facility" }],
  // ── Prescription Drug (explicit text matches) ──────────────────────────
  "generic drugs": [{ slug: "generic_rx", place: "any" }],
  "generic drugs on the prescription drug list": [{ slug: "generic_rx", place: "any" }],
  "preferred brand": [{ slug: "preferred_brand_rx", place: "any" }],
  "preferred brand name drugs": [{ slug: "preferred_brand_rx", place: "any" }],
  "non-preferred brand": [{ slug: "non_preferred_brand_rx", place: "any" }],
  "non-preferred brand name drugs": [{ slug: "non_preferred_brand_rx", place: "any" }],
  "specialty drugs": [{ slug: "specialty_rx", place: "any" }],
  "specialty medication": [{ slug: "specialty_rx", place: "any" }],
  "infusion therapy": [{ slug: "infusion_therapy", place: "outpatient_facility" }],
  "chemotherapy": [{ slug: "chemotherapy", place: "outpatient_facility" }],
  "radiation therapy": [{ slug: "radiation_therapy", place: "outpatient_facility" }],
  // ── Telehealth ──────────────────────────────────────────────────────────
  "telehealth": [{ slug: "telehealth", place: "virtual" }],
  "virtual visit": [{ slug: "telehealth", place: "virtual" }],
  "telemedicine": [{ slug: "telehealth", place: "virtual" }],
  "mdlive urgent care": [{ slug: "telehealth", place: "virtual" }],
  "mdlive primary care": [{ slug: "telehealth", place: "virtual" }],
  "mdlive specialty care": [{ slug: "telehealth_specialist", place: "virtual" }],
  "mdlive behavioral": [{ slug: "mental_health_outpatient", place: "virtual" }],
};

function matchServiceSlug(serviceName: string): { slug: string; place: string; fallback?: boolean } | null {
  const lower = serviceName.toLowerCase().trim();

  // Skip known non-service terms (exact match or substring match)
  if (NON_SERVICE_TERMS.has(lower)) return null;
  for (const term of NON_SERVICE_TERMS) {
    if (lower.startsWith(term)) return null;
  }
  // Skip all-caps strings > 30 chars (section headers)
  if (serviceName === serviceName.toUpperCase() && serviceName.length > 30) return null;
  // Skip strings with dollar amounts (cost lines, not service names)
  if (/\$\d/.test(serviceName)) return null;
  // Skip pure numbers/punctuation
  if (/^[\d\s.,;:%-]+$/.test(serviceName)) return null;

  // Direct match
  for (const [key, mappings] of Object.entries(SERVICE_NAME_MAP)) {
    if (lower.includes(key)) return mappings[0];
  }

  // Fuzzy keyword matching
  if (/prescri.*drug|pharmacy|rx/i.test(lower)) {
    if (/tier\s*1|generic/i.test(lower)) return { slug: "generic_rx", place: "any" };
    if (/tier\s*2|preferred.*brand/i.test(lower)) return { slug: "preferred_brand_rx", place: "any" };
    if (/tier\s*3|non.?preferred/i.test(lower)) return { slug: "non_preferred_brand_rx", place: "any" };
    if (/tier\s*4|specialty/i.test(lower)) return { slug: "specialty_rx", place: "any" };
    return { slug: "generic_rx", place: "any" };
  }

  if (/lab/i.test(lower) && !/collab|labor /i.test(lower)) return { slug: "lab_work", place: "any" };
  if (/x.?ray|radiol/i.test(lower)) return { slug: "imaging_xray", place: "any" };
  if (/mri|mra|cat\s*scan|pet\s*scan|ct\s*scan/i.test(lower)) return { slug: "imaging_advanced", place: "any" };
  if (/physical\s*therap/i.test(lower)) return { slug: "physical_therapy", place: "any" };
  if (/speech\s*therap/i.test(lower)) return { slug: "speech_therapy", place: "any" };
  if (/occupational\s*therap/i.test(lower)) return { slug: "occupational_therapy", place: "any" };
  if (/therap/i.test(lower)) return { slug: "physical_therapy", place: "any" };
  if (/surg/i.test(lower)) return { slug: "outpatient_surgery", place: "any" };
  if (/pregnan|matern|deliver|birth/i.test(lower)) return { slug: "maternity_delivery", place: "inpatient_facility" };
  if (/dialysis/i.test(lower)) return { slug: "dialysis", place: "outpatient_facility" };
  if (/hospice/i.test(lower)) return { slug: "hospice", place: "any" };
  if (/home\s*health/i.test(lower)) return { slug: "home_health", place: "home" };
  if (/allergy/i.test(lower)) return { slug: "allergy_treatment", place: "specialist_office" };
  if (/infusion/i.test(lower)) return { slug: "infusion_therapy", place: "outpatient_facility" };
  if (/chemo/i.test(lower)) return { slug: "chemotherapy", place: "outpatient_facility" };
  if (/radiation\s*therap/i.test(lower)) return { slug: "radiation_therapy", place: "outpatient_facility" };

  // No known mapping — generate a fallback slug (goes to admin for review, not user benefits)
  const generatedSlug = lower
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 50);

  if (generatedSlug.length >= 3) {
    return { slug: generatedSlug, place: "any", fallback: true };
  }
  return null;
}

// ── Legacy regex parser (private; reached via parsePlanDocument when flag OFF) ──
// Renamed from `parsePlanDocument` per S72 commit 3 (Q-S72-2 (b) LOCK). The new
// public `parsePlanDocument` dispatcher above flag-gates between this regex
// implementation and the Haiku-first parser. Implementation unchanged from
// pre-S72 — recall ~49% baseline; see Subplan §1 for replacement rationale.

function parsePlanDocumentRegex(text: string): PlanDocParseResult {
  const warnings: string[] = [];
  const plan: Partial<InsurancePlanInsert> = {};

  // ── Plan identity ───────────────────────────────────────────────────────

  // Insurer name: "CIGNA HEALTH AND LIFE INSURANCE COMPANY" or similar
  const insurerPatterns = [
    /(?:CIGNA|Cigna|AETNA|Aetna|BLUE\s*CROSS|Blue\s*Cross|UNITED\s*HEALTH|United\s*Health|ANTHEM|Anthem|HUMANA|Humana|KAISER|Kaiser)[\w\s&,.]*/i,
    /([A-Z][A-Z\s&]+(?:INSURANCE|HEALTH|LIFE)\s+(?:COMPANY|CORPORATION|GROUP|INC))/,
  ];
  const insurerMatch = firstMatch(text, insurerPatterns);
  if (insurerMatch) {
    const name = insurerMatch[0].trim().replace(/\s+/g, " ");
    // Normalize common names
    if (/cigna/i.test(name)) plan.insurer_name = "Cigna";
    else if (/aetna/i.test(name)) plan.insurer_name = "Aetna";
    else if (/blue\s*cross/i.test(name)) plan.insurer_name = "Blue Cross Blue Shield";
    else if (/united\s*health/i.test(name)) plan.insurer_name = "UnitedHealthcare";
    else if (/anthem/i.test(name)) plan.insurer_name = "Anthem";
    else if (/humana/i.test(name)) plan.insurer_name = "Humana";
    else if (/kaiser/i.test(name)) plan.insurer_name = "Kaiser Permanente";
    else plan.insurer_name = name.slice(0, 100);
  }

  // Plan name: "OPEN ACCESS PLUS" or from coverage line
  // Prioritize recognizable plan type names over generic header matches
  const planNamePatterns = [
    /OPEN\s+ACCESS\s+PLUS/i,
    /((?:CHOICE|SELECT|PREFERRED|BASIC|PREMIUM|STANDARD)[A-Z\s]*(?:PLUS|PPO|HMO|EPO|POS|HDHP|HSA))/i,
    /([A-Z][A-Z\s]+(?:PLUS|PPO|HMO|EPO|POS|HDHP|HSA)[A-Z\s]*)/,
    /GROUP\s+POLICY.*?[-–]\s*\w+\s+(.*?)(?:\n|BENEFITS)/i,
  ];
  const planNameMatch = firstMatch(text, planNamePatterns);
  if (planNameMatch) {
    let name = (planNameMatch[1] || planNameMatch[0]).trim().replace(/\s+/g, " ");
    // Clean up
    name = name.replace(/\s*MEDICAL\s*BENEFITS?\s*/i, "").replace(/\s*IN-NETWORK\s*/i, " ").trim();
    if (name.length > 3 && name.length < 100) {
      plan.plan_name = name;
      plan.network_name = name;
    }
  }

  // Plan type
  if (/open\s*access\s*plus|OAP/i.test(text)) plan.plan_type = "OAP";
  else if (/\bPPO\b/i.test(text)) plan.plan_type = "PPO";
  else if (/\bHMO\b/i.test(text)) plan.plan_type = "HMO";
  else if (/\bEPO\b/i.test(text)) plan.plan_type = "EPO";
  else if (/\bPOS\b/i.test(text)) plan.plan_type = "POS";
  else if (/\bHDHP\b/i.test(text)) plan.plan_type = "HDHP";

  // Employer / policyholder
  const employerPatterns = [
    /POLICYHOLDER:\s*(.+)/i,
    /(?:name of the Plan|Plan Sponsor)[\s:]+(.+)/i,
    /(?:Employer|Group)\s*Name:\s*(.+)/i,
  ];
  const employerMatch = firstMatch(text, employerPatterns);
  if (employerMatch?.[1]) {
    plan.employer_name = employerMatch[1].trim().replace(/\s+/g, " ").slice(0, 200);
  }

  // Policy number
  const policyPatterns = [
    /(?:GROUP\s+)?POLICY.*?(\d{5,})/i,
    /Policy\s*(?:Number|#|No)[\s.:]*(\d{5,})/i,
  ];
  const policyMatch = firstMatch(text, policyPatterns);

  // Coverage period / effective date
  const effectivePatterns = [
    /EFFECTIVE\s+DATE:\s*(\w+\s+\d{1,2},?\s+\d{4})/i,
    /effective\s+(?:on|as\s+of)\s+(\w+\s+\d{1,2},?\s+\d{4})/i,
    /coverage\s+(?:begins|starts|effective)\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i,
  ];
  const effectiveMatch = firstMatch(text, effectivePatterns);
  if (effectiveMatch?.[1]) {
    try {
      const d = new Date(effectiveMatch[1]);
      if (!isNaN(d.getTime())) {
        plan.coverage_period_start = d.toISOString().slice(0, 10);
        // Plan docs usually cover 1 year
        const endDate = new Date(d);
        endDate.setFullYear(endDate.getFullYear() + 1);
        endDate.setDate(endDate.getDate() - 1);
        plan.coverage_period_end = endDate.toISOString().slice(0, 10);
      }
    } catch { /* skip */ }
  }

  // ── Cost structure ──────────────────────────────────────────────────────

  // ── Deductible extraction — multi-pattern for different insurers ─────────
  const deductibleSectionPatterns = [
    /Calendar\s+Year\s+Deductible[\s\S]{0,500}/i,
    /Annual\s+Deductible[\s\S]{0,500}/i,
    /Your\s+Deductible[\s\S]{0,500}/i,
    /Plan\s+Deductible[\s\S]{0,500}/i,
    /In-Network\s+Deductible[\s\S]{0,500}/i,
    /Deductible\s*\(In-Network\)[\s\S]{0,500}/i,
    /The\s+Schedule[\s\S]{0,2000}Deductible[\s\S]{0,500}/i,
  ];

  const individualAmountPatterns = [
    /Individual[\s\S]{0,80}?\$\s*([\d,]+)\s*(?:per\s*(?:covered\s+)?person)?/i,
    /\$\s*([\d,]+)\s*(?:\/\s*Individual|per\s*(?:covered\s+)?person)/i,
    /Individual[:\s]+\$\s*([\d,]+)/i,
    /per\s+(?:covered\s+)?person[:\s]*\$\s*([\d,]+)/i,
    /Deductible[:\s]*\$\s*([\d,]+)\s*(?:individual|per\s*person)/i,
  ];

  const familyAmountPatterns = [
    /Family[\s\S]{0,80}?\$\s*([\d,]+)\s*(?:per\s*family)?/i,
    /\$\s*([\d,]+)\s*(?:\/\s*Family|per\s*family)/i,
    /Family[:\s]+\$\s*([\d,]+)/i,
  ];

  for (const sectionPattern of deductibleSectionPatterns) {
    if (plan.in_deductible_individual != null) break;
    const deductibleSection = text.match(sectionPattern)?.[0] || "";
    if (!deductibleSection) continue;

    for (const amtPattern of individualAmountPatterns) {
      const indivMatch = deductibleSection.match(amtPattern);
      if (indivMatch) {
        plan.in_deductible_individual = parseFloat(indivMatch[1].replace(/,/g, ""));
        break;
      }
    }
    for (const amtPattern of familyAmountPatterns) {
      const familyMatch = deductibleSection.match(amtPattern);
      if (familyMatch) {
        plan.in_deductible_family = parseFloat(familyMatch[1].replace(/,/g, ""));
        break;
      }
    }

    if (/Individual\s+Calculation/i.test(deductibleSection)) {
      plan.deductible_calc_method = "embedded";
    } else if (/Aggregate/i.test(deductibleSection)) {
      plan.deductible_calc_method = "aggregate";
    }
  }
  if (plan.in_deductible_individual == null) warnings.push("Could not extract in-network deductible");

  // ── OOP Max extraction — multi-pattern ─────────────────────────────────
  // CF-19 (Session 64) — $0 OOP Max regex bug fix. Previously the OOP-section
  // capture window (up to 500 chars after the OOP keyword) commonly bled into
  // neighboring DEDUCTIBLE rows in tabular SBCs (e.g., Cigna OAP). The reused
  // `individualAmountPatterns` array included a "Deductible[:\s]+$X individual"
  // pattern (intended for deductible section) that would then match "Deductible: $0
  // individual" inside the OOP window — landing $0 in `in_oop_max_individual`.
  //
  // Two fixes:
  //   1. Use OOP-specific amount patterns that do NOT include the "Deductible:"
  //      keyword anchor.
  //   2. Strip leading "Deductible:" prefixed lines from the captured OOP section
  //      before pattern matching (defensive — handles tabular bleed).
  const oopSectionPatterns = [
    /Out-of-Pocket\s+(?:Maximum|Limit)[\s\S]{0,500}/gi,
    /Maximum\s+Out-of-Pocket[\s\S]{0,500}/gi,
    /MOOP[\s\S]{0,500}/gi,
    /Annual\s+Out-of-Pocket[\s\S]{0,500}/gi,
    /Your\s+Out-of-Pocket[\s\S]{0,500}/gi,
  ];

  // OOP-specific amount patterns. CRITICALLY does NOT match "Deductible: $X"
  // (that pattern leaks into OOP windows in tabular SBCs).
  const oopIndividualAmountPatterns = [
    /Individual[\s\S]{0,80}?\$\s*([\d,]+)\s*(?:per\s*(?:covered\s+)?person)?/i,
    /\$\s*([\d,]+)\s*(?:\/\s*Individual|per\s*(?:covered\s+)?person)/i,
    /Individual[:\s]+\$\s*([\d,]+)/i,
    /per\s+(?:covered\s+)?person[:\s]*\$\s*([\d,]+)/i,
    // OOP-anchored variants (when section text includes the OOP-Max keyword inline)
    /(?:Out-of-Pocket|Maximum)[:\s]*\$\s*([\d,]+)\s*(?:individual|per\s*person)?/i,
  ];

  const oopFamilyAmountPatterns = [
    /Family[\s\S]{0,80}?\$\s*([\d,]+)\s*(?:per\s*family)?/i,
    /\$\s*([\d,]+)\s*(?:\/\s*Family|per\s*family)/i,
    /Family[:\s]+\$\s*([\d,]+)/i,
  ];

  for (const oopPattern of oopSectionPatterns) {
    if (plan.in_oop_max_individual != null) break;
    const oopMatches = [...text.matchAll(oopPattern)];
    for (const oopM of oopMatches) {
      // Defense-in-depth: strip lines that explicitly mention "Deductible" so
      // the OOP-amount patterns can't pick up a deductible value sitting in the
      // window. Preserve the rest of the OOP context.
      const oopSection = oopM[0]
        .split(/\n/)
        .filter((line) => !/\bdeductible\b/i.test(line))
        .join("\n");
      if (!oopSection.trim()) continue;

      for (const amtPattern of oopIndividualAmountPatterns) {
        const indivMatch = oopSection.match(amtPattern);
        if (indivMatch && !plan.in_oop_max_individual) {
          const candidate = parseFloat(indivMatch[1].replace(/,/g, ""));
          // Sanity: skip implausibly low values that hint at deductible bleed
          // (OOP Max should be at minimum >= deductible). Real OOP for individual
          // health plans is typically $1,000+; $0 indicates the regex matched the
          // wrong field.
          if (candidate >= 500 || (plan.in_deductible_individual != null && candidate >= plan.in_deductible_individual)) {
            plan.in_oop_max_individual = candidate;
            break;
          }
        }
      }
      for (const amtPattern of oopFamilyAmountPatterns) {
        const familyMatch = oopSection.match(amtPattern);
        if (familyMatch && !plan.in_oop_max_family) {
          const candidate = parseFloat(familyMatch[1].replace(/,/g, ""));
          if (candidate >= 500 || (plan.in_deductible_family != null && candidate >= plan.in_deductible_family)) {
            plan.in_oop_max_family = candidate;
            break;
          }
        }
      }
      if (plan.in_oop_max_individual) break;
    }
  }

  // Cross-validation: deductible must be <= OOP max. If we caught a deductible-bleed
  // through (despite the filter above), swap rather than persist nonsense.
  if (plan.in_deductible_individual != null && plan.in_oop_max_individual != null) {
    if (plan.in_deductible_individual > plan.in_oop_max_individual) {
      // Swap — the parser got them backwards
      const temp = plan.in_deductible_individual;
      plan.in_deductible_individual = plan.in_oop_max_individual;
      plan.in_oop_max_individual = temp;
      warnings.push("Swapped deductible/OOP max (deductible was larger)");
    }
  }

  if (plan.in_oop_max_individual == null) warnings.push("Could not extract in-network OOP max");

  // Default coinsurance: "The Percentage of Covered Expenses the Plan Pays: 90%"
  const coinPatterns = [
    /Percentage\s+of\s+Covered\s+Expenses.*?(\d+)\s*%/i,
    /plan\s+pays\s*:?\s*(\d+)\s*%/i,
    /coinsurance[:\s]+(\d+)\s*%/i,
  ];
  const coinMatch = firstMatch(text, coinPatterns);
  if (coinMatch?.[1]) {
    const planPays = parseInt(coinMatch[1], 10);
    plan.in_coinsurance_default = (100 - planPays) / 100;
  }

  // Combined Med/Rx OOP
  if (/Combined\s+Medical.*?Pharmacy.*?Out-of-Pocket/i.test(text)) {
    const yesNo = text.match(/Combined\s+Medical.*?Pharmacy[\s\S]{0,200}?(Yes|No)/i);
    plan.combined_medical_rx_oop = yesNo?.[1]?.toLowerCase() === "yes";
  }

  // Referral required
  if (/referral.*not\s+required|no\s+referral\s+required|direct\s+access/i.test(text)) {
    plan.referral_required = false;
  } else if (/referral.*required/i.test(text)) {
    plan.referral_required = true;
  }

  // ── ERISA / Admin info ──────────────────────────────────────────────────

  const adminInfo: Record<string, string> = {};

  if (policyMatch?.[1]) adminInfo.policy_number = policyMatch[1];
  if (plan.employer_name) plan.employer_name = plan.employer_name;

  // EIN
  const einMatch = text.match(/(?:EIN|Employer\s+Identification\s+Number)[:\s]*(\d{9}|\d{2}-?\d{7})/i);
  if (einMatch?.[1]) adminInfo.ein = einMatch[1].replace(/-/g, "");

  // ERISA plan number — must be exactly 3 digits, not part of a longer number
  const planNumMatch = text.match(/Plan\s+Number[:\s]*\n?\s*(\d{3})\b/i);
  if (planNumMatch?.[1] && !/\d/.test(text.charAt(text.indexOf(planNumMatch[0]) + planNumMatch[0].length))) {
    adminInfo.erisa_plan_number = planNumMatch[1];
  }

  // Plan administrator address
  const adminAddrMatch = text.match(
    /(?:sponsor|administrator)[\s\S]{0,200}?(\d+\s+\w[\w\s]+(?:Avenue|Ave|Street|St|Boulevard|Blvd|Road|Rd|Drive|Dr|Way|Lane|Ln)[,.\s]+(?:Suite|Ste|#)?\s*\d*[,.\s]+\w[\w\s]+,\s*[A-Z]{2}\s+\d{5})/i
  );
  if (adminAddrMatch?.[1]) adminInfo.plan_administrator_address = adminAddrMatch[1].trim();

  // Fiscal year end
  const fiscalMatch = text.match(/(?:fiscal|plan)\s+year\s+end[:\s]*(\d{1,2}\/\d{1,2})/i);
  if (fiscalMatch?.[1]) adminInfo.fiscal_year_end = fiscalMatch[1];

  if (Object.keys(adminInfo).length > 0) {
    plan.admin_info = adminInfo;
  }

  // ── Contact info ────────────────────────────────────────────────────────

  const contactInfo: Record<string, string> = {};

  // Phone
  const phoneMatch = text.match(/(?:Customer\s+Service|call)[\s\S]{0,100}?(1-\d{3}-\d{3}-\d{4}|\(\d{3}\)\s*\d{3}-\d{4})/i);
  if (phoneMatch?.[1]) contactInfo.phone = phoneMatch[1];

  // Portal
  if (/mycigna\.com/i.test(text)) contactInfo.portal_url = "myCigna.com";
  else {
    const portalMatch = text.match(/(?:visit|online|portal|website)[:\s]*((?:www\.|my)[a-z0-9]+\.[a-z]{2,})/i);
    if (portalMatch?.[1]) contactInfo.portal_url = portalMatch[1];
  }

  // Grievance email
  const grievanceMatch = text.match(/(?:grievance|complaint)[\s\S]{0,200}?([\w.+-]+@[\w.-]+\.[a-z]{2,})/i);
  if (grievanceMatch?.[1]) contactInfo.grievance_email = grievanceMatch[1];

  // State regulator
  const regulatorMatch = text.match(
    /(?:Department\s+of\s+(?:Insurance|Managed\s+Health)|DMHC|DOI)[\s\S]{0,100}?((?:1-)?\d{3}[-.]\d{3}[-.]\d{4}|\(\d{3}\)\s*\d{3}[-.]\d{4})/i
  );
  if (regulatorMatch?.[1]) {
    const stateMatch = text.match(/(California|CA|New York|NY|Texas|TX|Florida|FL|Illinois|IL|Pennsylvania|PA|Ohio|OH|Georgia|GA|Michigan|MI|Arizona|AZ)\s+(?:Department|DMHC)/i);
    contactInfo.state_regulator = `${stateMatch?.[1] || "State"}: ${regulatorMatch[1]}`;
  }

  if (Object.keys(contactInfo).length > 0) {
    plan.contact_info = contactInfo;
  }

  // ── Claims timelines ────────────────────────────────────────────────────

  const timelines: Record<string, number> = {};
  const preserviceMatch = text.match(/pre-?service[\s\S]{0,100}?(\d+)\s*(?:calendar\s+)?days/i);
  if (preserviceMatch?.[1]) timelines.preservice_days = parseInt(preserviceMatch[1], 10);
  const urgentMatch = text.match(/urgent[\s\S]{0,100}?(\d+)\s*hours/i);
  if (urgentMatch?.[1]) timelines.preservice_urgent_hours = parseInt(urgentMatch[1], 10);
  const postserviceMatch = text.match(/post-?service[\s\S]{0,100}?(\d+)\s*(?:calendar\s+)?days/i);
  if (postserviceMatch?.[1]) timelines.postservice_days = parseInt(postserviceMatch[1], 10);
  const concurrentMatch = text.match(/concurrent[\s\S]{0,100}?(\d+)\s*hours/i);
  if (concurrentMatch?.[1]) timelines.concurrent_hours = parseInt(concurrentMatch[1], 10);
  if (Object.keys(timelines).length > 0) plan.claims_timelines = timelines;

  // ── Timely filing ───────────────────────────────────────────────────────

  const timelyMatch = text.match(/(?:file|submit)[\s\S]{0,100}?(?:within|no\s+later\s+than)\s+(\d+)\s*days/i);
  if (timelyMatch?.[1]) plan.timely_filing_days_in = parseInt(timelyMatch[1], 10);

  // ── COBRA ───────────────────────────────────────────────────────────────

  const cobraMatch = text.match(/COBRA[\s\S]{0,500}?(\d+)\s*months/i);
  if (cobraMatch?.[1]) plan.cobra_months = parseInt(cobraMatch[1], 10);

  // ── Services ────────────────────────────────────────────────────────────

  const services: SBCParsedService[] = [];
  const seenKeys = new Set<string>();

  // Pattern: "Service Name\n\n$X per visit copay, then Y%" or "Plan deductible, then Y%"
  const costPatterns = [
    // "$20 per visit copay, then 100%"
    /(\$\d[\d,.]*\s+per\s+visit\s+copay[^%]*\d+\s*%)/gi,
    // "$250 per visit copay (waived if admitted), then plan deductible, then 90%"
    /(\$\d[\d,.]*\s+per\s+visit\s+copay\s*\([^)]+\)[^%]*\d+\s*%)/gi,
    // "Plan deductible, then 90%"
    /(Plan\s+deductible,\s+then\s+\d+\s*%)/gi,
    // "100%" standalone
    // "No charge after $X Copay"
    /No\s+charge\s+after\s+\$\d[\d,.]*\s+Copay/gi,
  ];

  // Find each cost description and look backward for the service name
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Check if this line contains a cost description
    const isCostLine =
      /^\$\d+.*copay/i.test(line) ||
      /^Plan\s+deductible/i.test(line) ||
      /^No\s+charge\s+after/i.test(line) ||
      /^\$\d+.*per\s+(?:day|visit|admission|session)/i.test(line) ||
      /^(?:Covered|Included)\s+in\s+full/i.test(line) ||
      /^No\s+charge/i.test(line) ||
      /^\d+%\s+(?:after|of)/i.test(line) ||
      /^Deductible,?\s+then\s+\d+/i.test(line) ||
      /^(?:In-Network|IN-NETWORK)[:\s]+\$\d/i.test(line) ||
      /^100\s*%$/i.test(line) || // Standalone "100%" for preventive/fully covered
      /^100%\s+at\s+/i.test(line); // "100% at LifeSOURCE center..."
    if (!isCostLine) continue;

    // Look backward for the service name (typically 1-5 lines before)
    let serviceName = "";
    for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
      const prevLine = lines[j].trim();
      if (!prevLine) continue;
      // Skip page headers, numbers, "myCigna.com", "IN-NETWORK", "BENEFIT HIGHLIGHTS"
      if (/^\d+$/.test(prevLine)) continue;
      if (/^myCigna|^IN-NETWORK|^BENEFIT HIGHLIGHTS|^OUT-OF-NETWORK|^Note:|^Page\s+\d|^\d+\s*$|^\.\s*$|^www\.|^http/i.test(prevLine)) continue;
      // Skip form feed characters and page breaks
      if (prevLine === '\f' || prevLine === '.') continue;
      // If this looks like a previous cost line, stop
      if (/^\$\d+.*copay|^Plan\s+deductible|^No\s+charge|^100\s*%$/i.test(prevLine)) break;
      serviceName = prevLine + (serviceName ? " " + serviceName : "");
      // Break if this looks like a complete service name header — starts with capital,
      // long enough to not be a continuation word (like "Visit", "Services", "Facility")
      // and not a known continuation fragment
      // Multi-line service names are common — don't break too early
      const isContinuation = /^(?:Visit|Services?|Facility|Provider|Benefits?|Room|Charges?|Care|Office|Hospital|Inpatient|Outpatient|Center|Program|Treatment|Therapy|Physician'?s?|Primary|Specialty|Imaging|Laboratory|Diagnostic|Emergency|Urgent|Ambulance|Surgical|Mental|Behavioral|Substance|Maternity|Prenatal|Newborn|Rehabilitation|Equipment|Prosthetic|Hearing|Durable|Speech|Occupational|Physical|Cardiac|Chiropractic|Acupuncture|Virtual|Telehealth|Preventive|Immunization|Screening|Radiology|Advanced|Professional|Surgeon|Pathologist|Anesthesiologist|Semi-Private|Private|Special|Operating|Recovery|Procedures?|Observation|Lab|X-ray|MRI|CT|PET|CAT)s?$/i.test(prevLine)
        || prevLine.length <= 20; // Longer threshold — most service name fragments are under 20 chars
      if (/^[A-Z]/.test(prevLine) && prevLine.length > 3 && !isContinuation) break;
    }

    if (!serviceName) continue;

    const mapping = matchServiceSlug(serviceName);
    if (!mapping) continue;

    const key = `${mapping.slug}:${mapping.place}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const parsed = parseCostDescription(line);

    // Check for annual limit in nearby lines
    let annualLimit: string | null = null;
    let annualLimitValue: number | null = null;
    for (let j = Math.max(0, i - 5); j <= Math.min(lines.length - 1, i + 3); j++) {
      const nearLine = lines[j].trim();
      const limitMatch = nearLine.match(/(?:Calendar\s+Year\s+)?Maximum:\s*(.+)/i);
      if (limitMatch) {
        annualLimit = limitMatch[1].trim();
        const numMatch = annualLimit.match(/(\d+)\s*(?:days|visits|sessions)/i);
        if (numMatch) annualLimitValue = parseInt(numMatch[1], 10);
        if (/unlimited/i.test(annualLimit)) { annualLimit = "Unlimited"; annualLimitValue = null; }
      }
    }

    // Check for prior auth
    let priorAuth: boolean | null = null;
    for (let j = Math.max(0, i - 10); j <= Math.min(lines.length - 1, i + 5); j++) {
      if (/prior\s+auth|pre-?cert|pre-?authorization/i.test(lines[j])) {
        priorAuth = true;
        break;
      }
    }

    // Rx-specific: supply days and home delivery
    let supplyLimitDays: number | null = null;
    let homeDeliveryCopay: number | null = null;
    if (/rx|drug|pharmacy|tier/i.test(serviceName)) {
      const supplyMatch = serviceName.match(/(\d+).?day/i) || line.match(/(\d+).?day/i);
      if (supplyMatch) supplyLimitDays = parseInt(supplyMatch[1], 10);
      if (/home\s+delivery|mail\s+order/i.test(serviceName)) {
        homeDeliveryCopay = parsed.copay;
      }
    }

    services.push({
      serviceSlug: mapping.slug,
      placeOfService: mapping.place,
      inCopay: parsed.copay,
      inCoinsurance: parsed.coinsurance,
      inDeductibleApplies: parsed.deductibleApplies,
      inCopayWaiverCondition: parsed.copayWaiverCondition,
      inCostDescription: line,
      outCopay: null, // Plan doc typically doesn't have OON details
      outCoinsurance: null,
      outDeductibleApplies: null,
      outCostDescription: "",
      oonPaidAtInNetwork: /emergency|air\s*ambulance/i.test(serviceName),
      annualLimit,
      annualLimitValue,
      priorAuthRequired: priorAuth,
      penaltyNoPrecert: null,
      covered: true,
      coverageConditions: null,
      supplyLimitDays,
      homeDeliveryCopay,
      stepTherapyRequired: null,
      notes: null,
      confidence: mapping.fallback ? 0.3 : 0.7,
    });
  }

  // ── Second pass: section-based service discovery ────────────────────────
  // Catches services mentioned in benefit sections that weren't found by
  // the cost-line scanner (e.g., bullet lists, tables, coverage summaries).
  // We look for known service names anywhere in the text and create entries
  // with reduced confidence if we can't extract cost details.
  const textLower = text.toLowerCase();
  for (const [name, mappings] of Object.entries(SERVICE_NAME_MAP)) {
    const mapping = mappings[0];
    const key = `${mapping.slug}:${mapping.place}`;
    if (seenKeys.has(key)) continue;

    // Check if this service name appears in the document
    if (!textLower.includes(name)) continue;

    // Find the context around the mention to try to extract cost info
    const idx = textLower.indexOf(name);
    const contextStart = Math.max(0, idx - 200);
    const contextEnd = Math.min(text.length, idx + name.length + 300);
    const context = text.slice(contextStart, contextEnd);

    // Try to extract cost from context
    const costMatch = context.match(/\$\s*([\d,]+(?:\.\d{2})?)\s*(?:per|copay)/i)
      || context.match(/(?:plan\s+deductible|deductible),?\s+then\s+(\d+)\s*%/i)
      || context.match(/(\d+)\s*%\s+(?:coinsurance|after)/i);

    const parsed = costMatch ? parseCostDescription(costMatch[0]) : null;

    // Check for coverage indicators
    const isCovered = !/not\s+covered|excluded/i.test(context);

    seenKeys.add(key);
    services.push({
      serviceSlug: mapping.slug,
      placeOfService: mapping.place,
      inCopay: parsed?.copay ?? null,
      inCoinsurance: parsed?.coinsurance ?? null,
      inDeductibleApplies: parsed?.deductibleApplies ?? null,
      inCopayWaiverCondition: parsed?.copayWaiverCondition ?? null,
      inCostDescription: costMatch ? costMatch[0].trim() : (isCovered ? "See plan document" : "Not covered"),
      outCopay: null,
      outCoinsurance: null,
      outDeductibleApplies: null,
      outCostDescription: "",
      oonPaidAtInNetwork: false,
      annualLimit: null,
      annualLimitValue: null,
      priorAuthRequired: /prior\s+auth|pre-?cert/i.test(context) ? true : null,
      penaltyNoPrecert: null,
      covered: isCovered,
      coverageConditions: null,
      supplyLimitDays: null,
      homeDeliveryCopay: null,
      stepTherapyRequired: null,
      notes: parsed ? null : "Cost details not extracted — refer to plan document",
      confidence: parsed ? 0.6 : 0.4,
    });
  }

  // ── Exclusions ──────────────────────────────────────────────────────────

  const exclusionSection = text.match(
    /Exclusions[\s\S]{0,5000}?(?=Coordination\s+of\s+Benefits|Payment\s+of\s+Benefits|Termination|$)/i
  )?.[0] || "";

  if (exclusionSection) {
    const exclusionPatterns = [
      /(?:not\s+covered|excluded)[\s:]*([^.;]+)/gi,
    ];
    for (const pattern of exclusionPatterns) {
      let m;
      while ((m = pattern.exec(exclusionSection)) !== null) {
        const excl = m[1].trim();
        const mapping = matchServiceSlug(excl);
        if (mapping) {
          const key = `${mapping.slug}:${mapping.place}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            services.push({
              serviceSlug: mapping.slug,
              placeOfService: mapping.place,
              inCopay: null, inCoinsurance: null, inDeductibleApplies: false,
              inCopayWaiverCondition: null, inCostDescription: "Not covered",
              outCopay: null, outCoinsurance: null, outDeductibleApplies: false,
              outCostDescription: "Not covered",
              oonPaidAtInNetwork: false,
              annualLimit: null, annualLimitValue: null,
              priorAuthRequired: null, penaltyNoPrecert: null,
              covered: false,
              coverageConditions: excl.length < 200 ? excl : null,
              supplyLimitDays: null, homeDeliveryCopay: null,
              stepTherapyRequired: null, notes: null,
              confidence: 0.5,
            });
          }
        }
      }
    }
  }

  // ── Confidence calculation ──────────────────────────────────────────────

  let confidence = 0;
  let fields = 0;
  const critical = [
    plan.insurer_name, plan.plan_name, plan.in_deductible_individual,
    plan.in_oop_max_individual, plan.in_coinsurance_default,
  ];
  for (const f of critical) {
    fields++;
    if (f != null) confidence += 0.15;
  }
  if (plan.employer_name) confidence += 0.05;
  if (plan.plan_type) confidence += 0.05;
  if (plan.coverage_period_start) confidence += 0.05;
  if (plan.admin_info && Object.keys(plan.admin_info).length > 2) confidence += 0.05;
  if (plan.contact_info) confidence += 0.03;
  if (services.length > 5) confidence += 0.05;
  if (services.length > 15) confidence += 0.05;
  confidence = Math.min(confidence, 1.0);
  confidence = Math.round(confidence * 100) / 100;

  return {
    plan,
    services,
    confidence,
    parseWarnings: warnings,
  };
}
