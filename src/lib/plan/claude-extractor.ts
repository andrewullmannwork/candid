/**
 * Claude Haiku primary extractor for SBC/plan documents.
 * Sends the full OCR text to Haiku for structured service extraction.
 * This replaces the regex parser as the primary extractor when enabled.
 *
 * Cost: ~$0.01/document (Haiku at $1/MTok input, typical SBC ~8K tokens)
 */

import Anthropic from "@anthropic-ai/sdk";
import type { SBCParsedService } from "./sbc-parser";

function getClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[claude-extractor] ANTHROPIC_API_KEY not set — Haiku extraction unavailable");
    return null;
  }
  return new Anthropic({ apiKey, timeout: 55000 });
}

/**
 * Primary SBC/plan document service extractor using Claude Haiku.
 * Sends the full OCR text and extracts structured service data directly.
 * Returns a complete SBCParsedService[] — no regex parser needed.
 */
export async function extractServicesWithClaude(
  ocrText: string,
  planName: string | null,
  isFullPlanDoc: boolean
): Promise<{ services: SBCParsedService[]; fromClaude: boolean; error?: string }> {
  const client = getClient();
  if (!client) {
    console.log("[claude-extractor] No API key — returning empty (will fall back to regex)");
    return { services: [], fromClaude: false };
  }

  console.log("[claude-extractor] Starting Haiku extraction for:", planName || "unknown plan", "| text length:", ocrText.length);

  // Truncate very long documents to stay within token limits (~100K chars ≈ 25K tokens).
  // Vercel Pro + maxDuration=60 gives enough time for Haiku to process the full document.
  const truncated = ocrText.length > 100000 ? ocrText.slice(0, 100000) : ocrText;

  const prompt = `You are parsing ${isFullPlanDoc ? "a full insurance plan benefits document" : "a Summary of Benefits and Coverage (SBC) document"}.

Plan name: ${planName || "Unknown"}

Extract EVERY actual healthcare service covered by this plan. For each service, return a JSON object with these exact fields:

{
  "serviceSlug": "lowercase_underscore_identifier",
  "serviceName": "Clean Human-Readable Service Name",
  "inCopay": number or null,
  "inCoinsurance": decimal (0.10 for 10%) or null,
  "inDeductibleApplies": true/false/null,
  "inCostDescription": "Concise: e.g., '$30 copay per visit' or '10% coinsurance after deductible'",
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

Use these standard slugs when they match:
pcp_visit, specialist_visit, preventive_care, diagnostic_test, advanced_imaging, generic_rx_tier1, preferred_brand_rx, non_preferred_rx, specialty_rx, outpatient_surgery_facility, outpatient_surgery_physician, er_visit, emergency_transport, urgent_care, inpatient_facility, inpatient_physician, mental_health_outpatient, mental_health_inpatient, substance_abuse_outpatient, substance_abuse_inpatient, prenatal_visit, delivery_facility, delivery_professional, home_health, pt_rehab, habilitation, skilled_nursing, durable_medical_equipment, hospice_inpatient, hospice_outpatient, chiropractic, acupuncture, speech_therapy, occupational_therapy, telehealth, nutritional_counseling, childrens_eye_exam, childrens_glasses, childrens_dental

For any service not in the list above, create a descriptive slug (e.g., "bariatric_surgery", "allergy_testing").

CRITICAL RULES:
- Extract ONLY actual healthcare services (things a patient can receive)
- DO NOT extract section headers like "What You Will Pay", "Common Medical Event", "In-Network Provider"
- DO NOT extract cost structure labels like "Deductibles", "Copayments", "Coinsurance"
- DO NOT extract page numbers, disclaimers, legal notices, language assistance text
- Keep inCostDescription to ONE clean sentence (e.g., "$50 copay per office visit, 10% coinsurance for other services")
- If a service has both copay AND coinsurance, include BOTH in the description
- Separate office visit costs from facility/other costs when the document distinguishes them

Return ONLY a JSON array. No markdown fencing, no explanation.

Document text:
${truncated}`;

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 16384,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    console.log("[claude-extractor] Haiku response length:", text.length, "| usage:", JSON.stringify(response.usage));

    // Parse JSON — handle potential markdown fencing
    const jsonStr = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const extracted: Array<{
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
    }> = JSON.parse(jsonStr);

    console.log("[claude-extractor] Extracted", extracted.length, "services from Haiku");

    // Convert to SBCParsedService format
    const services: SBCParsedService[] = extracted.map((e) => ({
      serviceSlug: e.serviceSlug,
      placeOfService: "any",
      inCopay: e.inCopay ?? null,
      inCoinsurance: e.inCoinsurance ?? null,
      inDeductibleApplies: e.inDeductibleApplies ?? null,
      inCopayWaiverCondition: null,
      inCostDescription: e.inCostDescription || "",
      outCopay: e.outCopay ?? null,
      outCoinsurance: e.outCoinsurance ?? null,
      outDeductibleApplies: e.outDeductibleApplies ?? null,
      outCostDescription: e.outCostDescription || "",
      oonPaidAtInNetwork: false,
      annualLimit: e.annualLimit || null,
      annualLimitValue: e.annualLimit ? parseInt(e.annualLimit.match(/\d+/)?.[0] || "0", 10) || null : null,
      priorAuthRequired: e.priorAuthRequired ?? null,
      penaltyNoPrecert: null,
      covered: e.covered ?? true,
      coverageConditions: e.coverageConditions || null,
      supplyLimitDays: null,
      homeDeliveryCopay: null,
      stepTherapyRequired: e.stepTherapyRequired ?? null,
      notes: null,
      confidence: e.confidence ?? 0.85,
    }));

    return { services, fromClaude: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[claude-extractor] Haiku extraction error:", errMsg);
    // Return the error message so callers can log it
    return { services: [], fromClaude: false, error: errMsg };
  }
}

/**
 * Legacy enrichment function — kept for backward compatibility but
 * extractServicesWithClaude is now the preferred approach.
 */
export async function enrichServicesWithClaude(
  services: SBCParsedService[],
  ocrText: string,
  planName: string | null
): Promise<SBCParsedService[]> {
  // Delegate to the primary extractor — if it returns results, use those instead
  const result = await extractServicesWithClaude(ocrText, planName, false);
  if (result.fromClaude && result.services.length > 0) {
    return result.services;
  }
  // Fall back to returning the original services unchanged
  return services;
}
