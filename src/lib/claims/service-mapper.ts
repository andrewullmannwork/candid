/**
 * Service Mapper — maps bill line item descriptions to service_catalog slugs via Haiku.
 *
 * Given a list of bill line items (with provider-written descriptions and billing codes),
 * returns a service_slug for each one. The slug connects the bill to plan_covered_services,
 * enabling cross-bill and cross-plan comparison.
 *
 * This is the T0.5 billing code strategy: we never use AMA-authored CPT descriptions.
 * We map the provider's own description text to Candid's plain-English service categories.
 */

import Anthropic from "@anthropic-ai/sdk";
import { jsonrepair } from "jsonrepair";
import type { BillingCodeType } from "@/lib/supabase/types";

const MODEL = "claude-haiku-4-5-20251001";

export interface LineItemInput {
  lineNumber: number;
  description: string;
  billingCode?: string;
  billingCodeType?: BillingCodeType | null;
  category?: string;
}

export interface ServiceMapping {
  lineNumber: number;
  serviceSlug: string;
  confidence: number;
}

// All slugs from service_catalog (migration 010). Haiku picks from this list only.
const SERVICE_SLUGS = [
  "pcp_visit", "specialist_visit", "telehealth_pcp", "telehealth_specialist",
  "convenience_care_clinic", "second_opinion",
  "preventive_care", "annual_physical", "immunizations", "cancer_screening",
  "well_child_visit", "womens_sterilization",
  "er_visit", "emergency_transport_ground", "emergency_transport_air", "urgent_care",
  "inpatient_facility", "inpatient_physician",
  "outpatient_surgery_facility", "outpatient_surgery_physician",
  "diagnostic_test", "advanced_imaging", "radiology_basic",
  "lab_pcp_office", "lab_specialist_office", "lab_outpatient_facility", "lab_independent",
  "generic_rx_tier1", "preferred_brand_rx_tier2", "non_preferred_rx_tier3", "specialty_rx_tier4",
  "preventive_rx", "chemotherapy_rx",
  "pt_rehab", "ot_rehab", "speech_therapy", "pulmonary_rehab", "cognitive_therapy",
  "cardiac_rehab", "chiropractic", "acupuncture", "habilitation",
  "mental_health_outpatient", "mental_health_inpatient", "mental_health_telehealth",
  "mental_health_partial", "substance_abuse_outpatient", "substance_abuse_inpatient",
  "prenatal_visit", "delivery_facility", "delivery_professional",
  "durable_medical_equipment", "prosthetics", "diabetic_equipment",
  "home_health", "skilled_nursing", "hospice_inpatient", "hospice_outpatient",
  "bereavement_counseling", "dialysis", "transplant", "nutritional_counseling",
  "genetic_counseling", "allergy_treatment", "medical_pharmaceuticals", "gene_therapy",
  "abortion", "bariatric_surgery", "childrens_eye_exam", "childrens_glasses",
  "childrens_dental", "dental_injury",
] as const;

function getClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[service-mapper] ANTHROPIC_API_KEY not set");
    return null;
  }
  return new Anthropic({ apiKey, timeout: 30000, maxRetries: 2 });
}

function parseJSON(text: string): unknown {
  const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    console.log("[service-mapper] JSON.parse failed, attempting repair...");
    const repaired = jsonrepair(cleaned);
    return JSON.parse(repaired);
  }
}

/**
 * Infer billing code type from the code string itself.
 * More accurate than the old length-based heuristic.
 */
export function inferBillingCodeType(code: string): BillingCodeType {
  if (!code) return "unknown";
  const trimmed = code.trim().toUpperCase();

  // HCPCS Level II: letter (A-V) followed by 4 digits
  if (/^[A-V]\d{4}$/.test(trimmed)) return "HCPCS";

  // CPT: exactly 5 digits (possibly with F suffix for Category II)
  if (/^\d{5}[FUT]?$/.test(trimmed)) return "CPT";

  // Revenue code: 4 digits, typically starts with 0
  if (/^0\d{3}$/.test(trimmed)) return "REV";

  // ICD-10: letter followed by digits with optional dot
  if (/^[A-Z]\d{2}\.?\d{0,4}$/.test(trimmed)) return "ICD10";

  // NDC: 10-11 digits, may contain dashes
  if (/^\d{4,5}-\d{3,4}-\d{1,2}$/.test(trimmed) || /^\d{10,11}$/.test(trimmed)) return "NDC";

  // DRG: 3 digits
  if (/^\d{3}$/.test(trimmed)) return "DRG";

  // Fallback: 5-digit numeric → likely CPT
  if (/^\d{5}$/.test(trimmed)) return "CPT";

  return "unknown";
}

/**
 * Map bill line item descriptions to service_catalog slugs.
 *
 * First checks billing_code_mappings for known high-confidence codes.
 * Items that aren't cached are batched into a single Haiku call.
 * This saves API costs as the community code database grows.
 *
 * Cost: ~$0.001-0.003 per bill for uncached items.
 */
export async function mapLineItemsToServices(
  lineItems: LineItemInput[]
): Promise<ServiceMapping[]> {
  if (lineItems.length === 0) return [];

  // Phase 1: Check cached code mappings for known codes
  const results: ServiceMapping[] = [];
  const uncachedItems: LineItemInput[] = [];

  try {
    const { createServerClient } = await import("@/lib/supabase/server");
    const { getCachedCodeMapping } = await import("@/lib/claims/code-intelligence");
    const supabase = createServerClient();

    for (const item of lineItems) {
      if (item.billingCode && item.billingCodeType) {
        const cached = await getCachedCodeMapping(supabase, item.billingCode, item.billingCodeType);
        if (cached) {
          results.push({
            lineNumber: item.lineNumber,
            serviceSlug: cached.serviceSlug,
            confidence: cached.confidence,
          });
          continue;
        }
      }
      uncachedItems.push(item);
    }

    if (results.length > 0) {
      console.log(`[service-mapper] ${results.length}/${lineItems.length} resolved from cached code mappings`);
    }
  } catch {
    // If cache lookup fails, fall through to Haiku for all items
    uncachedItems.push(...lineItems.filter((li) => !results.some((r) => r.lineNumber === li.lineNumber)));
  }

  // Phase 2: Call Haiku for uncached items
  if (uncachedItems.length === 0) return results;

  const client = getClient();
  if (!client) {
    console.warn("[service-mapper] No API client — returning cached results only");
    return results;
  }

  const itemList = uncachedItems.map((item) => {
    const parts = [`Line ${item.lineNumber}: "${item.description}"`];
    if (item.billingCode) parts.push(`Code: ${item.billingCode}`);
    if (item.billingCodeType) parts.push(`(${item.billingCodeType})`);
    if (item.category) parts.push(`Category hint: ${item.category}`);
    return parts.join(" ");
  }).join("\n");

  const prompt = `Map each bill line item to the BEST matching service slug from this list:

${SERVICE_SLUGS.join(", ")}

Line items from a medical bill:
${itemList}

Rules:
- Use the description text and billing code to determine the service type
- Pick the single best slug — do not invent new slugs
- If a line item truly doesn't match anything (e.g., administrative fees), use "other" as the slug with low confidence
- confidence is 0.0-1.0: high (0.8+) for clear matches, medium (0.5-0.7) for reasonable guesses, low (<0.5) for uncertain

Return JSON array, one object per line item:
[{"lineNumber": 1, "serviceSlug": "specialist_visit", "confidence": 0.9}, ...]`;

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const parsed = parseJSON(text) as Array<{
      lineNumber: number;
      serviceSlug: string;
      confidence: number;
    }>;

    if (!Array.isArray(parsed)) {
      console.error("[service-mapper] Unexpected response shape:", typeof parsed);
      return [];
    }

    // Validate slugs — only accept known service_catalog slugs
    const validSlugs = new Set<string>(SERVICE_SLUGS);
    const haikuResults = parsed
      .filter((m) => validSlugs.has(m.serviceSlug) || m.serviceSlug === "other")
      .map((m) => ({
        lineNumber: m.lineNumber,
        serviceSlug: m.serviceSlug,
        confidence: Math.max(0, Math.min(1, m.confidence)),
      }));

    // Merge cached results + Haiku results
    return [...results, ...haikuResults];
  } catch (err) {
    console.error("[service-mapper] Haiku call failed:", err);
    return results; // Return cached results even if Haiku fails
  }
}
