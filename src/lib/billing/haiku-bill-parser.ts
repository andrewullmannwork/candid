/**
 * Haiku-based bill parser — extracts structured billing data from OCR text.
 *
 * Replaces the fragile regex parser for line item extraction. Handles ANY bill format:
 * Providence Swedish itemized receipts, hospital bills, EOBs, multi-line layouts, etc.
 *
 * Uses the same pattern as claude-extractor.ts (plan document parser):
 * OCR text → Haiku → structured JSON → ParsedBill
 *
 * Cost: ~$0.01-0.03 per bill (typically 1-page documents).
 */

import Anthropic from "@anthropic-ai/sdk";
import { jsonrepair } from "jsonrepair";
import type { ParsedBill, BillLineItem } from "./types";
import { categorizeProcedureCode } from "./parser";
import { randomUUID } from "crypto";

const MODEL = "claude-haiku-4-5-20251001";

function getClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[haiku-bill-parser] ANTHROPIC_API_KEY not set");
    return null;
  }
  return new Anthropic({ apiKey, timeout: 30000, maxRetries: 2 });
}

function parseJSON(text: string): unknown {
  const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    console.log("[haiku-bill-parser] JSON.parse failed, attempting repair...");
    const repaired = jsonrepair(cleaned);
    return JSON.parse(repaired);
  }
}

interface HaikuBillResult {
  provider: {
    name: string;
    npi?: string;
    address?: string;
  };
  patient: {
    name: string;
    memberId?: string;
    groupNumber?: string;
  };
  insurer?: {
    name: string;
    planName?: string;
  };
  serviceDate: string; // ISO date
  statementDate?: string;
  lineItems: Array<{
    description: string; // Provider's description from the bill (verbatim)
    procedureCode?: string; // CPT, HCPCS, etc.
    procedureCodeType?: string; // "CPT", "HCPCS", "REV", etc.
    revenueCode?: string;
    modifier?: string;
    quantity: number;
    billedAmount: number;
    allowedAmount?: number;
    insurancePaid?: number;
    patientResponsibility?: number;
    adjustments?: number;
    serviceDate?: string;
  }>;
  totals: {
    totalBilled: number;
    totalAllowed?: number;
    totalInsurancePaid?: number;
    totalPatientResponsibility?: number;
    totalAdjustments?: number;
  };
}

const PROMPT = `Extract structured billing data from this medical bill/EOB. Return a JSON object.

CRITICAL RULES:
- Extract the provider's EXACT description text for each line item (e.g., "Injection of allergenic extracts into skin"). Never use AMA/CPT descriptions.
- Extract the billing code NUMBER separately (e.g., "95004"). The code is NOT a dollar amount.
- Dollar amounts have $ signs or appear in amount columns. A 5-digit number like 95004 next to "CPT code:" is a PROCEDURE CODE, not an amount.
- Lines with $0.00 charges are tracking/quality codes — still extract them.
- Dates should be ISO format (YYYY-MM-DD).
- If a field is not present in the bill, omit it (don't guess).

Return this JSON structure:
{
  "provider": { "name": "string", "npi": "string?", "address": "string?" },
  "patient": { "name": "string", "memberId": "string?", "groupNumber": "string?" },
  "insurer": { "name": "string?", "planName": "string?" },
  "serviceDate": "YYYY-MM-DD",
  "statementDate": "YYYY-MM-DD?",
  "lineItems": [
    {
      "description": "Provider's exact description text from the bill",
      "procedureCode": "95004",
      "procedureCodeType": "CPT",
      "revenueCode": "0250?",
      "modifier": "25?",
      "quantity": 1,
      "billedAmount": 924.00,
      "allowedAmount": 500.00,
      "insurancePaid": 400.00,
      "patientResponsibility": 100.00,
      "adjustments": 424.00,
      "serviceDate": "YYYY-MM-DD?"
    }
  ],
  "totals": {
    "totalBilled": 1404.00,
    "totalAllowed": 642.09,
    "totalInsurancePaid": 521.45,
    "totalPatientResponsibility": 154.49,
    "totalAdjustments": 761.91
  }
}

Bill text:
`;

/**
 * Parse a bill using Haiku. Falls back to regex parser on failure.
 */
export async function parseBillWithHaiku(
  ocrText: string,
  documentId: string,
  userId: string,
  billType: "eob" | "itemized_bill",
): Promise<ParsedBill | null> {
  const client = getClient();
  if (!client) return null;

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content: PROMPT + ocrText }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const result = parseJSON(text) as HaikuBillResult;

    if (!result || !result.lineItems || !Array.isArray(result.lineItems)) {
      console.error("[haiku-bill-parser] Invalid response structure");
      return null;
    }

    // Convert Haiku result to ParsedBill format
    const lineItems: BillLineItem[] = result.lineItems.map((item, idx) => ({
      lineNumber: idx + 1,
      procedureCode: item.procedureCode || "",
      revenueCode: item.revenueCode,
      description: item.description || "Medical service",
      category: item.procedureCode ? categorizeProcedureCode(item.procedureCode) : "Medical Service",
      serviceDate: item.serviceDate || result.serviceDate || new Date().toISOString().split("T")[0],
      quantity: item.quantity || 1,
      billedAmount: item.billedAmount || 0,
      allowedAmount: item.allowedAmount,
      insurancePaid: item.insurancePaid,
      patientResponsibility: item.patientResponsibility,
      adjustments: item.adjustments,
      modifier: item.modifier,
    }));

    const parsedBill: ParsedBill = {
      id: randomUUID(),
      documentId,
      userId,
      billType,
      provider: {
        name: result.provider?.name || "Unknown Provider",
        npi: result.provider?.npi,
        address: result.provider?.address,
      },
      patient: {
        name: result.patient?.name || "Unknown",
        memberId: result.patient?.memberId,
        groupNumber: result.patient?.groupNumber,
      },
      insurer: result.insurer ? { name: result.insurer.name, planName: result.insurer.planName } : undefined,
      serviceDate: result.serviceDate || new Date().toISOString().split("T")[0],
      statementDate: result.statementDate,
      lineItems,
      totals: {
        totalBilled: result.totals?.totalBilled || lineItems.reduce((s, li) => s + li.billedAmount, 0),
        totalAllowed: result.totals?.totalAllowed,
        totalInsurancePaid: result.totals?.totalInsurancePaid,
        totalPatientResponsibility: result.totals?.totalPatientResponsibility,
        totalAdjustments: result.totals?.totalAdjustments,
      },
      rawText: ocrText,
      confidence: 0.85, // Haiku extraction is high confidence
      parseErrors: [],
    };

    console.log(`[haiku-bill-parser] Extracted ${lineItems.length} line items, total billed $${parsedBill.totals.totalBilled}`);
    return parsedBill;
  } catch (err) {
    console.error("[haiku-bill-parser] Extraction failed:", err);
    return null;
  }
}
