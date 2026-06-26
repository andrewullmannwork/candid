/**
 * Claude Haiku service extractor for SBC/plan documents.
 *
 * Single-pass extraction with comprehensive category checklist.
 * If output is truncated (stop_reason: max_tokens), makes ONE follow-up
 * call for remaining services. jsonrepair handles any malformed JSON.
 *
 * Cost: ~$0.03-0.08/document depending on size.
 */

import Anthropic from "@anthropic-ai/sdk";
import { parseHaikuJSON } from "@/lib/parser/safe-json";
import type { SBCParsedService, SBCParsedAppealsContact } from "@/lib/sbc/types";
import { normalizeCoinsuranceForStorage } from "@/lib/billing/coinsurance";

const MODEL = "claude-haiku-4-5-20251001";

function getClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[claude-extractor] ANTHROPIC_API_KEY not set");
    return null;
  }
  return new Anthropic({ apiKey, timeout: 120000, maxRetries: 3 });
}

function parseJSON(text: string): unknown {
  // S94 B1 — delegate to shared parseHaikuJSON which handles trailing reasoning
  // text + code fences + balanced-block extraction + jsonrepair fallback.
  return parseHaikuJSON(text);
}

// LEGACY plan-document parser STANDARD_SLUGS. Per S93 PR #80 F.14 closure, this
// claude-extractor is SKIPPED when the Haiku-first plan_doc parser produces
// services successfully. Vocabulary kept aligned to the S94 B1 68-slug canonical
// list for defensive consistency. Source of truth:
// plans/s94_unified_parser_meet_or_beat.md "Locked Canonical Winners".
const STANDARD_SLUGS = `pcp_visit, specialist_visit, home_health, preventive_care, immunizations, annual_physical, cancer_screening, adult_dental_care, childrens_dental_checkup, childrens_eye_exam, childrens_glasses, routine_eye_care_adult, weight_loss_programs, vision_exam, vision_hardware, dental_orthodontic, er_visit, urgent_care, emergency_transport_ground, emergency_transport_air, non_emergency_care_outside_us, inpatient_facility, inpatient_physician, outpatient_surgery_facility, outpatient_surgery_physician, bariatric_surgery, cosmetic_surgery, advanced_imaging, diagnostic_test, imaging_basic, lab_outpatient, generic_rx_tier1, generic_rx_tier1_90day, preferred_brand_rx_tier2, preferred_brand_rx_90day, non_preferred_rx_tier3, non_preferred_rx_90day, specialty_rx_tier4, preventive_rx, chemotherapy_rx, pt_rehab, ot_rehab, speech_therapy, chiropractic, acupuncture, habilitation, nutritional_counseling, routine_foot_care, cardiac_rehab, mental_health_outpatient, mental_health_inpatient, substance_abuse_outpatient, substance_abuse_inpatient, prenatal_visit, delivery_facility, delivery_professional, infertility_treatment, well_baby, hospice_inpatient, hospice_outpatient, long_term_care, private_duty_nursing, skilled_nursing, durable_medical_equipment, hearing_aids, childrens_dental`;

const CATEGORY_CHECKLIST = `Look for services in ALL of these categories:
- Physician visits (PCP, specialist, second opinion, consultant, OB/GYN)
- Virtual/telehealth care (MDLIVE, virtual visits, dedicated virtual providers) — emit pcp_visit or specialist_visit; place=virtual is captured by the service layer
- Preventive care and screenings (mammograms, PSA, PAP, immunizations, wellness exams)
- Convenience care clinic
- Emergency services (ER, urgent care)
- Hospital services (inpatient facility, outpatient facility, inpatient physician, outpatient professional)
- Surgery (inpatient, outpatient, bariatric/obesity surgery)
- Lab and diagnostic services
- Radiology services
- Advanced imaging (MRI, MRA, CT, CAT, PET scans)
- Therapy services (physical therapy, occupational therapy, speech therapy, cardiac rehab, pulmonary rehab)
- Chiropractic and spinal manipulation
- Acupuncture
- Mental health (inpatient, outpatient)
- Substance use disorder (inpatient, outpatient, detox)
- Maternity care (initial visit, prenatal visits, delivery facility, delivery professional, abortion)
- Prescription drugs (EACH tier separately: generic/Tier 1, preferred brand/Tier 2, non-preferred/Tier 3, specialty)
- Home health care
- Hospice (inpatient, outpatient)
- Bereavement counseling
- Skilled nursing facility
- DME (durable medical equipment)
- External prosthetic appliances and diabetic equipment
- Transplant services
- Dialysis (outpatient, home)
- Infertility treatment (include even if not covered)
- Dental care (injury-related)
- Nutritional and genetic counseling
- Gene therapy and advanced cellular therapy
- Medical pharmaceuticals and chemotherapy medication
- Ambulance (ground and air)
- Women's surgical sterilization
- Allergy treatment/injections
- Any other healthcare service in the document not listed above`;

function buildPrompt(
  ocrText: string,
  planName: string | null,
  isFullPlanDoc: boolean,
  existingSlugs?: string[]
): string {
  const truncated = ocrText.length > 100000 ? ocrText.slice(0, 100000) : ocrText;
  const docType = isFullPlanDoc ? "a full insurance plan benefits document" : "an SBC document";

  if (existingSlugs && existingSlugs.length > 0) {
    // Continuation call — extract remaining services not already found
    return `You are parsing ${docType}. Plan name: ${planName || "Unknown"}

These services have ALREADY been extracted: ${existingSlugs.join(", ")}

Extract any REMAINING healthcare services NOT in the list above. Use the same JSON format.
If a service is listed as "Not Covered", still include it with covered: false.
Each service appears ONCE. Return ONLY a JSON array. No markdown, no explanation.
If no additional services are found, return an empty array: []

For each service return: { "serviceSlug", "serviceName", "inCopay", "inCoinsurance", "inDeductibleApplies", "inCostDescription", "outCopay", "outCoinsurance", "outDeductibleApplies", "outCostDescription", "priorAuthRequired", "annualLimit", "stepTherapyRequired", "covered", "coverageConditions", "confidence" }

Document text:
${truncated}`;
  }

  return `You are parsing ${docType}. Plan name: ${planName || "Unknown"}

Extract every unique healthcare service covered by this plan. Be THOROUGH.

${CATEGORY_CHECKLIST}

Return a JSON object of the form:
{
  "services": [ /* service objects — see below */ ],
  "appealsContact": { /* optional — see bottom */ } or null
}

For each service, include:
{
  "serviceSlug": "lowercase_underscore_identifier",
  "serviceName": "Clean Human-Readable Name",
  "inCopay": number or null,
  "inCoinsurance": decimal (0.10 for 10%) or null,
  "inDeductibleApplies": true/false/null,
  "inCostDescription": "Concise: '$30 copay per visit' or '10% coinsurance after deductible'",
  "outCopay": number or null,
  "outCoinsurance": decimal (0.10 for 10%) or null,
  "outDeductibleApplies": true/false/null,
  "outCostDescription": "Concise out-of-network cost or empty string",
  "priorAuthRequired": true/false/null,
  "annualLimit": "e.g., '60 visits per year' or null",
  "stepTherapyRequired": true/false/null,
  "covered": true/false,
  "coverageConditions": "Special conditions or null",
  "confidence": 0.5-1.0,
  "sourceExcerpt": "Verbatim passage from the document that establishes this cost (one sentence max, no paraphrasing)" or null,
  "sourcePage": page number as integer or null
}

Standard slugs (use when they match): ${STANDARD_SLUGS}
For others, create descriptive slugs (e.g., "bariatric_surgery", "gene_therapy").

CRITICAL RULES:
- Each unique service appears ONCE — deduplicate across sections
- Extract ONLY patient-receivable services, not section headers or labels
- Keep inCostDescription to ONE concise sentence
- If a service has both copay AND coinsurance, include BOTH
- If listed as "Not Covered", include with covered: false
- For Rx, list each tier as a separate service with retail AND home delivery costs
- For supply limits, always format as "90-day supply", "30-day supply" (hyphenated, space before "supply")
- sourceExcerpt is the verbatim passage — DO NOT paraphrase or summarize. If you cannot locate a single clean passage, leave it null.

For appealsContact, scan the document for the Member Services / Appeals / Grievances address block (often on the back pages of SBCs and plan documents). Return null if none is present. Otherwise:
{
  "addressLine1": "PO Box or street address",
  "addressLine2": null or additional line,
  "city": "City",
  "state": "Two-letter state code",
  "postalCode": "ZIP or ZIP+4",
  "phone": "1-800-... or null",
  "sourceExcerpt": "verbatim passage",
  "sourcePage": page number or null,
  "confidence": 0.5-1.0
}

Return ONLY a JSON object with keys "services" and "appealsContact". No markdown, no explanation.

Document text:
${truncated}`;
}

interface RawExtracted {
  serviceSlug: string;
  serviceName?: string;
  inCopay?: number | null;
  inCoinsurance?: number | null;
  inDeductibleApplies?: boolean | null;
  inCostDescription?: string;
  outCopay?: number | null;
  outCoinsurance?: number | null;
  outDeductibleApplies?: boolean | null;
  outCostDescription?: string;
  priorAuthRequired?: boolean | null;
  annualLimit?: string | null;
  stepTherapyRequired?: boolean | null;
  covered?: boolean;
  coverageConditions?: string | null;
  confidence?: number;
  sourceExcerpt?: string | null;
  sourcePage?: number | null;
}

interface RawAppealsContact {
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  phone?: string | null;
  sourceExcerpt?: string | null;
  sourcePage?: number | null;
  confidence?: number | null;
}

interface RawExtractionPayload {
  services?: RawExtracted[];
  appealsContact?: RawAppealsContact | null;
}

// Fix "90day" → "90-day", "30day" → "30-day" etc. in extracted text fields.
// S93 — defensive against Haiku returning non-string types (numbers, booleans,
// objects) for fields the prompt declares as string. Pre-fix: text.replace()
// crashed with "TypeError: e.replace is not a function" (minified `text` →
// `e`), aborting the entire claude-extractor run + producing
// `partial_no_services` even on docs with extractable services. Found via
// 2026-05-15 Cigna SBC PROD smoke (doc 9ce50158).
function fixDayFormatting(text: unknown): string {
  if (text == null) return "";
  if (typeof text !== "string") return String(text);
  return text.replace(/(\d+)(day|days)\b/gi, "$1-$2");
}

function toSBCParsedService(e: RawExtracted): SBCParsedService {
  return {
    serviceSlug: e.serviceSlug,
    placeOfService: "any",
    inCopay: e.inCopay ?? null,
    inCoinsurance: normalizeCoinsuranceForStorage(e.inCoinsurance ?? null),
    inDeductibleApplies: e.inDeductibleApplies ?? null,
    inCopayWaiverCondition: null,
    inCostDescription: fixDayFormatting(e.inCostDescription),
    outCopay: e.outCopay ?? null,
    outCoinsurance: normalizeCoinsuranceForStorage(e.outCoinsurance ?? null),
    outDeductibleApplies: e.outDeductibleApplies ?? null,
    outCostDescription: fixDayFormatting(e.outCostDescription),
    oonPaidAtInNetwork: false,
    annualLimit: fixDayFormatting(e.annualLimit),
    // CF-63 RC-2 (S128): refactored from inline `parseInt(...) || null` which
    // coerced legitimate $0 annual-limit values to NULL. Now: missing input or
    // no-digit-match returns null; successful parse (including 0) returns the
    // numeric value.
    annualLimitValue: (() => {
      if (!e.annualLimit) return null;
      const digits = e.annualLimit.match(/\d+/)?.[0];
      if (!digits) return null;
      const parsed = parseInt(digits, 10);
      return Number.isNaN(parsed) ? null : parsed;
    })(),
    priorAuthRequired: e.priorAuthRequired ?? null,
    penaltyNoPrecert: null,
    covered: e.covered ?? true,
    coverageConditions: fixDayFormatting(e.coverageConditions),
    supplyLimitDays: null,
    homeDeliveryCopay: null,
    stepTherapyRequired: e.stepTherapyRequired ?? null,
    notes: null,
    confidence: e.confidence ?? 0.85,
    sourceExcerpt: e.sourceExcerpt ?? null,
    sourcePage: e.sourcePage ?? null,
  };
}

function toAppealsContact(raw: RawAppealsContact | null | undefined): SBCParsedAppealsContact | null {
  if (!raw?.addressLine1) return null;
  return {
    addressLine1: raw.addressLine1 ?? null,
    addressLine2: raw.addressLine2 ?? null,
    city: raw.city ?? null,
    state: raw.state ?? null,
    postalCode: raw.postalCode ?? null,
    phone: raw.phone ?? null,
    sourceExcerpt: raw.sourceExcerpt ?? null,
    sourcePage: raw.sourcePage ?? null,
    confidence: raw.confidence ?? 0.7,
  };
}

function normalizeExtractedPayload(value: unknown): { services: RawExtracted[]; appealsContact: RawAppealsContact | null } {
  // Back-compat: old prompt returned an array of services directly.
  if (Array.isArray(value)) {
    return { services: value as RawExtracted[], appealsContact: null };
  }
  const obj = (value ?? {}) as RawExtractionPayload;
  return {
    services: Array.isArray(obj.services) ? obj.services : [],
    appealsContact: obj.appealsContact ?? null,
  };
}

export async function extractServicesWithClaude(
  ocrText: string,
  planName: string | null,
  isFullPlanDoc: boolean
): Promise<{ services: SBCParsedService[]; appealsContact: SBCParsedAppealsContact | null; fromClaude: boolean; error?: string }> {
  const client = getClient();
  if (!client) {
    return { services: [], appealsContact: null, fromClaude: false, error: "ANTHROPIC_API_KEY not set" };
  }

  console.log("[claude-extractor] Starting extraction for:", planName || "unknown plan", "| text length:", ocrText.length);

  try {
    // Primary extraction call
    const prompt = buildPrompt(ocrText, planName, isFullPlanDoc);
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8192,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    console.log(`[claude-extractor] Response: ${text.length} chars | stop: ${response.stop_reason} | usage: ${JSON.stringify(response.usage)}`);

    const payload = normalizeExtractedPayload(parseJSON(text));
    let allServices = payload.services;
    const appealsContactRaw = payload.appealsContact;
    console.log(`[claude-extractor] Extracted ${allServices.length} services${appealsContactRaw ? " + appealsContact" : ""}`);

    // If truncated, make ONE continuation call for remaining services
    if (response.stop_reason === "max_tokens" || (response.stop_reason === "end_turn" && allServices.length === 0)) {
      if (response.stop_reason === "max_tokens") {
        console.log("[claude-extractor] Output truncated — making continuation call...");
        const existingSlugs = allServices.map(s => s.serviceSlug);
        const contPrompt = buildPrompt(ocrText, planName, isFullPlanDoc, existingSlugs);
        const contResponse = await client.messages.create({
          model: MODEL,
          max_tokens: 8192,
          temperature: 0,
          messages: [{ role: "user", content: contPrompt }],
        });
        const contText = contResponse.content[0].type === "text" ? contResponse.content[0].text : "";
        console.log(`[claude-extractor] Continuation: ${contText.length} chars | stop: ${contResponse.stop_reason}`);

        try {
          const contPayload = normalizeExtractedPayload(parseJSON(contText));
          if (contPayload.services.length > 0) {
            allServices = [...allServices, ...contPayload.services];
            console.log(`[claude-extractor] Total after continuation: ${allServices.length} services`);
          }
        } catch {
          console.warn("[claude-extractor] Continuation JSON parse failed — using initial results");
        }
      }
    }

    if (allServices.length === 0) {
      return { services: [], appealsContact: toAppealsContact(appealsContactRaw), fromClaude: false, error: "Haiku returned 0 services" };
    }

    const services = allServices.map(toSBCParsedService);
    return { services, appealsContact: toAppealsContact(appealsContactRaw), fromClaude: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[claude-extractor] Extraction error:", errMsg);
    return { services: [], appealsContact: null, fromClaude: false, error: errMsg };
  }
}
