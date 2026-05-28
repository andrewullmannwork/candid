/**
 * Haiku-based insurance card extractor — extracts structured fields from card OCR text.
 *
 * Replaces fragile regex parsing for non-standard card layouts. Handles:
 * - Cards with unusual formatting, multi-line labels, or OCR artifacts
 * - Non-English card elements, abbreviated field labels
 * - Cards from smaller/regional insurers without regex patterns
 *
 * Uses same pattern as haiku-bill-parser.ts and claude-extractor.ts:
 * OCR text -> Haiku -> structured JSON -> InsuranceCardFields
 *
 * Cost: ~$0.001-0.003 per card (small text, single image).
 */

import Anthropic from "@anthropic-ai/sdk";
import { jsonrepair } from "jsonrepair";
import type { InsuranceCardFields } from "@/types/insurance-card";

const MODEL = "claude-haiku-4-5-20251001";

function getClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[haiku-card] ANTHROPIC_API_KEY not set");
    return null;
  }
  return new Anthropic({ apiKey, timeout: 15000, maxRetries: 2 });
}

function parseJSON(text: string): unknown {
  const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    console.log("[haiku-card] JSON.parse failed, attempting repair...");
    const repaired = jsonrepair(cleaned);
    return JSON.parse(repaired);
  }
}

/** Per-field confidence from Haiku */
export interface HaikuCardResult {
  insurer?: string;
  insurerConfidence?: number;
  planName?: string;
  planNameConfidence?: number;
  planType?: string;
  planTypeConfidence?: number;
  groupNumber?: string;
  groupNumberConfidence?: number;
  memberId?: string;
  memberIdConfidence?: number;
  copayPrimary?: number;
  copaySpecialist?: number;
  copayEr?: number;
  copayUrgentCare?: number;
  copayRx?: number;
  deductibleIndividual?: number;
  deductibleFamily?: number;
  oopMaxIndividual?: number;
  oopMaxFamily?: number;
  coinsurancePct?: number;
  rxBin?: string;
  rxPcn?: string;
  rxGroup?: string;
  networkName?: string;
  insurerPhone?: string;
  zipCode?: string;
}

const PROMPT = `Extract structured fields from this insurance card OCR text. Return a JSON object.

RULES:
- Extract ONLY fields clearly present in the text. If a field is not visible, omit it entirely.
- For the insurer name, normalize to the parent company name (e.g., "Florida Blue" -> "Anthem / Blue Cross Blue Shield", "Ambetter" -> "Centene").
- Common insurer normalizations:
  - Any Blue Cross/Blue Shield affiliate (Premera, Regence, Highmark, CareFirst, etc.) -> "Anthem / Blue Cross Blue Shield"
  - Health Net, Ambetter, WellCare -> "Centene"
  - Open Access Plus, Choice Plus -> these are Cigna plan types, insurer is "Cigna"
- Member ID is a numeric or alphanumeric identifier (NOT the member's name). Look for labels like "Member ID", "Subscriber ID", "ID #", "Identification No."
- Group Number may appear as "Group", "Grp", "Group No.", "Group #"
- Plan Type values: HMO, PPO, EPO, HDHP, POS, Medicare Advantage, Medicare, Medicaid
- Copays are dollar amounts (integers usually $10-$100). Look for "PCP", "Primary", "Specialist", "ER", "Urgent Care", "Rx"
- Deductible and OOP Max may appear as dual values "IND/FAM $3500/$7000" — split into individual and family
- Phone numbers: look for "Member Services" or toll-free (800/888/877/866) numbers
- Zip code: 5-digit code, usually in an address context
- For each critical field (insurer, memberId, groupNumber, planName, planType), provide a confidence score 0.0-1.0

Return this JSON (omit fields not found):
{
  "insurer": "Normalized insurer name",
  "insurerConfidence": 0.95,
  "planName": "Plan name as shown on card",
  "planNameConfidence": 0.8,
  "planType": "PPO",
  "planTypeConfidence": 0.9,
  "groupNumber": "ABC123",
  "groupNumberConfidence": 0.95,
  "memberId": "W123456789",
  "memberIdConfidence": 0.95,
  "copayPrimary": 25,
  "copaySpecialist": 50,
  "copayEr": 250,
  "copayUrgentCare": 75,
  "copayRx": 15,
  "deductibleIndividual": 3500,
  "deductibleFamily": 7000,
  "oopMaxIndividual": 6250,
  "oopMaxFamily": 12500,
  "coinsurancePct": 20,
  "rxBin": "004336",
  "rxPcn": "ADV",
  "rxGroup": "RX1234",
  "networkName": "Choice Plus",
  "insurerPhone": "(800) 123-4567",
  "zipCode": "98101"
}

Card OCR text:
`;

/**
 * Extract insurance card fields using Haiku.
 * Returns null if Haiku is unavailable or extraction fails — caller should fall back to regex.
 */
export async function extractCardWithHaiku(
  ocrText: string,
): Promise<{ fields: InsuranceCardFields; haikuResult: HaikuCardResult } | null> {
  if (!ocrText || ocrText.trim().length < 20) {
    console.warn("[haiku-card] OCR text too short, skipping Haiku");
    return null;
  }

  const client = getClient();
  if (!client) return null;

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      temperature: 0,
      messages: [{ role: "user", content: PROMPT + ocrText }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const result = parseJSON(text) as HaikuCardResult;

    if (!result || typeof result !== "object") {
      console.error("[haiku-card] Invalid response structure");
      return null;
    }

    // Convert to InsuranceCardFields
    const fields: InsuranceCardFields = { rawText: ocrText };

    if (result.insurer) fields.insurer = result.insurer;
    if (result.planName) fields.planName = result.planName;
    if (result.planType) fields.planType = result.planType;
    if (result.groupNumber) fields.groupNumber = result.groupNumber;
    if (result.memberId) fields.memberId = result.memberId;
    if (result.copayPrimary != null) fields.copayPrimary = result.copayPrimary;
    if (result.copaySpecialist != null) fields.copaySpecialist = result.copaySpecialist;
    if (result.copayEr != null) fields.copayEr = result.copayEr;
    if (result.copayUrgentCare != null) fields.copayUrgentCare = result.copayUrgentCare;
    if (result.copayRx != null) fields.copayRx = result.copayRx;
    if (result.deductibleIndividual != null) fields.deductibleIndividual = result.deductibleIndividual;
    if (result.deductibleFamily != null) fields.deductibleFamily = result.deductibleFamily;
    if (result.oopMaxIndividual != null) fields.oopMaxIndividual = result.oopMaxIndividual;
    if (result.oopMaxFamily != null) fields.oopMaxFamily = result.oopMaxFamily;
    if (result.coinsurancePct != null) fields.coinsurancePct = result.coinsurancePct;
    if (result.rxBin) fields.rxBin = result.rxBin;
    if (result.rxPcn) fields.rxPcn = result.rxPcn;
    if (result.rxGroup) fields.rxGroup = result.rxGroup;
    if (result.networkName) fields.networkName = result.networkName;
    if (result.insurerPhone) fields.insurerPhone = result.insurerPhone;
    if (result.zipCode) fields.zipCode = result.zipCode;

    const foundFields = Object.keys(fields).filter(k => k !== "rawText" && fields[k as keyof InsuranceCardFields] != null).length;
    console.log(`[haiku-card] Extracted ${foundFields} fields | insurer: ${fields.insurer || "NONE"} | memberId: ${fields.memberId || "NONE"}`);

    return { fields, haikuResult: result };
  } catch (err) {
    console.error("[haiku-card] Extraction failed:", err);
    return null;
  }
}

/**
 * Calculate overall confidence from Haiku's per-field confidences.
 * Weights critical identity fields higher than cost fields.
 */
export function calculateHaikuConfidence(result: HaikuCardResult): number {
  const weights: { field: keyof HaikuCardResult; weight: number }[] = [
    { field: "insurerConfidence", weight: 3 },
    { field: "memberIdConfidence", weight: 3 },
    { field: "groupNumberConfidence", weight: 2 },
    { field: "planTypeConfidence", weight: 1 },
    { field: "planNameConfidence", weight: 1 },
  ];

  let totalWeight = 0;
  let weightedSum = 0;

  for (const { field, weight } of weights) {
    const value = result[field] as number | undefined;
    if (value != null) {
      weightedSum += value * weight;
      totalWeight += weight;
    }
  }

  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}
