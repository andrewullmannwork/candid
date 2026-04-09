/**
 * Claude Haiku three-pass extractor for SBC/plan documents.
 *
 * Pass 1: Extract raw service list (slug + name only — fast, bounded output)
 * Pass 2: Deduplicate and consolidate (no document text — tiny output)
 * Pass 3: Extract cost details for each consolidated service
 *
 * This approach prevents output token overflow on large (72+ page) documents
 * where a single-pass extraction produces 1000+ entries and truncates.
 *
 * Cost: ~$0.15/document (three Haiku calls × ~25K input tokens each)
 */

import Anthropic from "@anthropic-ai/sdk";
import type { SBCParsedService } from "./sbc-parser";

const MODEL = "claude-haiku-4-5-20251001";

function getClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[claude-extractor] ANTHROPIC_API_KEY not set");
    return null;
  }
  return new Anthropic({ apiKey, timeout: 120000 });
}

const STANDARD_SLUGS = `pcp_visit, specialist_visit, preventive_care, diagnostic_test, advanced_imaging, generic_rx_tier1, preferred_brand_rx, non_preferred_rx, specialty_rx, outpatient_surgery_facility, outpatient_surgery_physician, er_visit, emergency_transport, urgent_care, inpatient_facility, inpatient_physician, mental_health_outpatient, mental_health_inpatient, substance_abuse_outpatient, substance_abuse_inpatient, prenatal_visit, delivery_facility, delivery_professional, home_health, pt_rehab, habilitation, skilled_nursing, durable_medical_equipment, hospice_inpatient, hospice_outpatient, chiropractic, acupuncture, speech_therapy, occupational_therapy, telehealth, nutritional_counseling, childrens_eye_exam, childrens_glasses, childrens_dental`;

function parseJSON(text: string): unknown {
  const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  return JSON.parse(cleaned);
}

async function callHaiku(client: Anthropic, prompt: string, maxTokens: number): Promise<string> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text : "";
  console.log(`[claude-extractor] Haiku response: ${text.length} chars | usage: ${JSON.stringify(response.usage)}`);
  return text;
}

// ── Pass 1: Raw service extraction ──────────────────────────────────────────

async function pass1_extractServiceList(
  client: Anthropic,
  ocrText: string,
  planName: string | null,
  isFullPlanDoc: boolean
): Promise<Array<{ serviceSlug: string; serviceName: string }>> {
  const truncated = ocrText.length > 100000 ? ocrText.slice(0, 100000) : ocrText;

  const prompt = `You are parsing ${isFullPlanDoc ? "a full insurance plan benefits document" : "an SBC document"}.
Plan name: ${planName || "Unknown"}

List every unique healthcare service covered by this plan. A "service" is something a patient can receive (e.g., "Primary Care Visit", "Generic Drugs Tier 1", "MRI").

DO NOT include:
- Section headers, cost structure labels, legal terms, disclaimers
- Deductibles, copayments, coinsurance as standalone items
- Page numbers, table of contents entries, or formatting artifacts

Return ONLY a JSON array of: [{ "serviceSlug": "lowercase_underscore", "serviceName": "Clean Name" }]

Use these standard slugs when they match:
${STANDARD_SLUGS}

For services not in the list, create a descriptive slug (e.g., "bariatric_surgery").

IMPORTANT: Each unique service should appear ONCE. If a service is mentioned multiple times across different sections, include it only once.

Return ONLY the JSON array. No markdown, no explanation.

Document text:
${truncated}`;

  const text = await callHaiku(client, prompt, 4096);
  const result = parseJSON(text) as Array<{ serviceSlug: string; serviceName: string }>;
  console.log(`[claude-extractor] Pass 1: ${result.length} raw services`);
  return result;
}

// ── Pass 2: Deduplicate and consolidate ─────────────────────────────────────

async function pass2_deduplicateServices(
  client: Anthropic,
  rawServices: Array<{ serviceSlug: string; serviceName: string }>
): Promise<Array<{ serviceSlug: string; serviceName: string; covered: boolean }>> {
  const prompt = `Deduplicate and consolidate this list of healthcare services. Many entries refer to the same service with slightly different names.

Rules:
1. Merge duplicates — keep the clearest name
2. Use standard slugs where they match: ${STANDARD_SLUGS}
3. Remove anything that isn't an actual patient-receivable service
4. Mark all as covered: true (these came from a covered services document)
5. Maximum 125 unique services

Input services:
${JSON.stringify(rawServices, null, 0)}

Return ONLY a JSON array of: [{ "serviceSlug": "...", "serviceName": "...", "covered": true }]
No markdown, no explanation.`;

  const text = await callHaiku(client, prompt, 4096);
  const result = parseJSON(text) as Array<{ serviceSlug: string; serviceName: string; covered: boolean }>;
  console.log(`[claude-extractor] Pass 2: ${result.length} deduplicated services (from ${rawServices.length} raw)`);
  return result;
}

// ── Pass 3: Extract cost details ────────────────────────────────────────────

async function pass3_extractCostDetails(
  client: Anthropic,
  services: Array<{ serviceSlug: string; serviceName: string }>,
  ocrText: string,
  planName: string | null,
  isFullPlanDoc: boolean
): Promise<SBCParsedService[]> {
  const truncated = ocrText.length > 100000 ? ocrText.slice(0, 100000) : ocrText;

  const prompt = `You are extracting cost details from ${isFullPlanDoc ? "a full insurance plan benefits document" : "an SBC document"}.
Plan name: ${planName || "Unknown"}

For EACH of these services, find the in-network and out-of-network cost details in the document below.

Services to extract costs for:
${JSON.stringify(services.map(s => ({ slug: s.serviceSlug, name: s.serviceName })), null, 0)}

For each service, return:
{
  "serviceSlug": "matching slug from list above",
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
  "covered": true,
  "coverageConditions": "Special conditions or null",
  "confidence": 0.5-1.0
}

Rules:
- Keep inCostDescription to ONE concise sentence
- If cost info is not found for a service, set confidence to 0.5 and descriptions to empty
- If a service has both copay AND coinsurance, include BOTH in the description

Return ONLY a JSON array. No markdown, no explanation.

Document text:
${truncated}`;

  const text = await callHaiku(client, prompt, 8192);
  const extracted = parseJSON(text) as Array<{
    serviceSlug: string;
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
  }>;

  console.log(`[claude-extractor] Pass 3: ${extracted.length} services with cost details`);

  return extracted.map((e) => ({
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
}

// ── Main entry point ────────────────────────────────────────────────────────

export async function extractServicesWithClaude(
  ocrText: string,
  planName: string | null,
  isFullPlanDoc: boolean
): Promise<{ services: SBCParsedService[]; fromClaude: boolean; error?: string }> {
  const client = getClient();
  if (!client) {
    return { services: [], fromClaude: false, error: "ANTHROPIC_API_KEY not set" };
  }

  console.log("[claude-extractor] Starting three-pass extraction for:", planName || "unknown plan", "| text length:", ocrText.length);

  try {
    // Pass 1: Extract raw service list
    const rawServices = await pass1_extractServiceList(client, ocrText, planName, isFullPlanDoc);
    if (rawServices.length === 0) {
      return { services: [], fromClaude: false, error: "Pass 1 returned 0 services" };
    }

    // Pass 2: Deduplicate
    const consolidated = await pass2_deduplicateServices(client, rawServices);
    if (consolidated.length === 0) {
      return { services: [], fromClaude: false, error: "Pass 2 returned 0 services after dedup" };
    }

    // Check against configurable max
    const maxServices = parseInt(process.env.MAX_EXTRACTED_SERVICES || "125", 10);
    if (consolidated.length > maxServices) {
      return {
        services: [],
        fromClaude: false,
        error: `Pass 2 returned ${consolidated.length} services (max ${maxServices}) — flagging for review`,
      };
    }

    // Pass 3: Extract cost details
    const services = await pass3_extractCostDetails(client, consolidated, ocrText, planName, isFullPlanDoc);

    console.log(`[claude-extractor] Three-pass complete: ${rawServices.length} raw → ${consolidated.length} deduped → ${services.length} with costs`);
    return { services, fromClaude: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[claude-extractor] Extraction error:", errMsg);
    return { services: [], fromClaude: false, error: errMsg };
  }
}
