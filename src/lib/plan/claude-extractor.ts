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
import { jsonrepair } from "jsonrepair";
import type { SBCParsedService } from "./sbc-parser";

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
  const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    console.log("[claude-extractor] JSON.parse failed, attempting repair...");
    const repaired = jsonrepair(cleaned);
    return JSON.parse(repaired);
  }
}

const STANDARD_SLUGS = `pcp_visit, specialist_visit, preventive_care, diagnostic_test, advanced_imaging, generic_rx_tier1, preferred_brand_rx, non_preferred_rx, specialty_rx, outpatient_surgery_facility, outpatient_surgery_physician, er_visit, emergency_transport, urgent_care, inpatient_facility, inpatient_physician, mental_health_outpatient, mental_health_inpatient, substance_abuse_outpatient, substance_abuse_inpatient, prenatal_visit, delivery_facility, delivery_professional, home_health, pt_rehab, habilitation, skilled_nursing, durable_medical_equipment, hospice_inpatient, hospice_outpatient, chiropractic, acupuncture, speech_therapy, occupational_therapy, telehealth, nutritional_counseling, childrens_eye_exam, childrens_glasses, childrens_dental`;

const CATEGORY_CHECKLIST = `Look for services in ALL of these categories:
- Physician visits (PCP, specialist, second opinion, consultant, OB/GYN)
- Virtual/telehealth care (MDLIVE, virtual visits, dedicated virtual providers)
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

For each service, return a JSON object:
{
  "serviceSlug": "lowercase_underscore_identifier",
  "serviceName": "Clean Human-Readable Name",
  "inCopay": number or null,
  "inCoinsurance": decimal (0.10 for 10%) or null,
  "inDeductibleApplies": true/false/null,
  "inCostDescription": "Concise: '$30 copay per visit' or '10% coinsurance after deductible'",
  "outCopay": number or null,
  "outCoinsurance": decimal or null,
  "outDeductibleApplies": true/false/null,
  "outCostDescription": "Concise out-of-network cost or empty string",
  "priorAuthRequired": true/false/null,
  "annualLimit": "e.g., '60 visits per year' or null",
  "stepTherapyRequired": true/false/null,
  "covered": true/false,
  "coverageConditions": "Special conditions or null",
  "confidence": 0.5-1.0
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

Return ONLY a JSON array. No markdown, no explanation.

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
}

// Fix "90day" → "90-day", "30day" → "30-day" etc. in extracted text fields
function fixDayFormatting(text: string | null | undefined): string {
  if (!text) return text || "";
  return text.replace(/(\d+)(day|days)\b/gi, "$1-$2");
}

function toSBCParsedService(e: RawExtracted): SBCParsedService {
  return {
    serviceSlug: e.serviceSlug,
    placeOfService: "any",
    inCopay: e.inCopay ?? null,
    inCoinsurance: e.inCoinsurance ?? null,
    inDeductibleApplies: e.inDeductibleApplies ?? null,
    inCopayWaiverCondition: null,
    inCostDescription: fixDayFormatting(e.inCostDescription),
    outCopay: e.outCopay ?? null,
    outCoinsurance: e.outCoinsurance ?? null,
    outDeductibleApplies: e.outDeductibleApplies ?? null,
    outCostDescription: fixDayFormatting(e.outCostDescription),
    oonPaidAtInNetwork: false,
    annualLimit: fixDayFormatting(e.annualLimit),
    annualLimitValue: e.annualLimit ? parseInt(e.annualLimit.match(/\d+/)?.[0] || "0", 10) || null : null,
    priorAuthRequired: e.priorAuthRequired ?? null,
    penaltyNoPrecert: null,
    covered: e.covered ?? true,
    coverageConditions: fixDayFormatting(e.coverageConditions),
    supplyLimitDays: null,
    homeDeliveryCopay: null,
    stepTherapyRequired: e.stepTherapyRequired ?? null,
    notes: null,
    confidence: e.confidence ?? 0.85,
  };
}

export async function extractServicesWithClaude(
  ocrText: string,
  planName: string | null,
  isFullPlanDoc: boolean
): Promise<{ services: SBCParsedService[]; fromClaude: boolean; error?: string }> {
  const client = getClient();
  if (!client) {
    return { services: [], fromClaude: false, error: "ANTHROPIC_API_KEY not set" };
  }

  console.log("[claude-extractor] Starting extraction for:", planName || "unknown plan", "| text length:", ocrText.length);

  try {
    // Primary extraction call
    const prompt = buildPrompt(ocrText, planName, isFullPlanDoc);
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    console.log(`[claude-extractor] Response: ${text.length} chars | stop: ${response.stop_reason} | usage: ${JSON.stringify(response.usage)}`);

    const extracted = parseJSON(text) as RawExtracted[];
    let allServices = extracted;
    console.log(`[claude-extractor] Extracted ${allServices.length} services`);

    // If truncated, make ONE continuation call for remaining services
    if (response.stop_reason === "max_tokens" || (response.stop_reason === "end_turn" && allServices.length === 0)) {
      if (response.stop_reason === "max_tokens") {
        console.log("[claude-extractor] Output truncated — making continuation call...");
        const existingSlugs = allServices.map(s => s.serviceSlug);
        const contPrompt = buildPrompt(ocrText, planName, isFullPlanDoc, existingSlugs);
        const contResponse = await client.messages.create({
          model: MODEL,
          max_tokens: 8192,
          messages: [{ role: "user", content: contPrompt }],
        });
        const contText = contResponse.content[0].type === "text" ? contResponse.content[0].text : "";
        console.log(`[claude-extractor] Continuation: ${contText.length} chars | stop: ${contResponse.stop_reason}`);

        try {
          const contExtracted = parseJSON(contText) as RawExtracted[];
          if (contExtracted.length > 0) {
            allServices = [...allServices, ...contExtracted];
            console.log(`[claude-extractor] Total after continuation: ${allServices.length} services`);
          }
        } catch {
          console.warn("[claude-extractor] Continuation JSON parse failed — using initial results");
        }
      }
    }

    if (allServices.length === 0) {
      return { services: [], fromClaude: false, error: "Haiku returned 0 services" };
    }

    const services = allServices.map(toSBCParsedService);
    return { services, fromClaude: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[claude-extractor] Extraction error:", errMsg);
    return { services: [], fromClaude: false, error: errMsg };
  }
}
