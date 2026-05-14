// Bill parser — extracts structured billing data from OCR text
// Handles both EOBs and itemized hospital bills

import type { ParsedBill, BillLineItem } from "./types";
import type { OCRResult } from "../ocr/types";
import { inferProcedureCodeType } from "./code-type-inference";
import { randomUUID } from "crypto";

// CPT code pattern: 5 digits, optionally followed by a modifier
const CPT_PATTERN = /\b(\d{5})(?:\s*[-–]\s*(\d{2}))?\b/;
// Revenue code pattern: 4 digits typically starting with 0
const REVENUE_CODE_PATTERN = /\b(0\d{3})\b/;
// Dollar amount pattern
const DOLLAR_PATTERN = /\$?\s*([\d,]+\.?\d{0,2})/;
// Date pattern (MM/DD/YYYY or YYYY-MM-DD)
const DATE_PATTERN =
  /(\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})/;
// NPI pattern: 10-digit number
const NPI_PATTERN = /\bNPI[:\s]*(\d{10})\b/i;

// S74.5c §2.3 — moved the legacy categorization map + lookup to a client-safe
// module (no `crypto` import) so ClaimDetail.tsx can surface a
// "<category> — review needed" hint per Subplan §5. Re-exported here so the
// existing server-side import surface (haiku-bill-parser, persist, audit
// rules) is unchanged. Local imports keep the function callable within
// this module too.
import { categorizeProcedureCode } from "./code-categories";
export { categorizeProcedureCode };

export function parseBillFromOCR(
  ocrResult: OCRResult,
  documentId: string,
  userId: string,
  billType: "eob" | "itemized_bill"
): ParsedBill {
  const text = ocrResult.text;
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const parseErrors: string[] = [];

  // Extract provider info
  const provider = extractProvider(lines, parseErrors);

  // Extract patient info
  const patient = extractPatient(lines, parseErrors);

  // Extract insurer info
  const insurer = extractInsurer(lines, parseErrors);

  // Extract dates
  const serviceDate = extractDate(lines, "service") || new Date().toISOString().split("T")[0];
  const statementDate = extractDate(lines, "statement");

  // Extract line items
  const lineItems = extractLineItems(lines, billType, parseErrors);

  // Calculate totals
  const totals = calculateTotals(lineItems);

  return {
    id: randomUUID(),
    documentId,
    userId,
    billType,
    provider,
    patient,
    insurer,
    serviceDate,
    statementDate,
    lineItems,
    totals,
    rawText: text,
    confidence: ocrResult.confidence,
    parseErrors,
  };
}

function extractProvider(
  lines: string[],
  errors: string[]
): ParsedBill["provider"] {
  const result: ParsedBill["provider"] = { name: "" };

  // Look for NPI
  const fullText = lines.join(" ");
  const npiMatch = fullText.match(NPI_PATTERN);
  if (npiMatch) result.npi = npiMatch[1];

  // Provider name is typically in the first few lines
  // Look for common patterns
  for (const line of lines.slice(0, 15)) {
    const lower = line.toLowerCase();
    if (
      lower.includes("hospital") ||
      lower.includes("medical center") ||
      lower.includes("clinic") ||
      lower.includes("health system") ||
      lower.includes("physicians")
    ) {
      result.name = line.replace(/[^\w\s&.,-]/g, "").trim();
      break;
    }
  }

  if (!result.name) {
    // Fallback: use the first non-empty line that looks like a name
    result.name = lines[0] || "Unknown Provider";
    errors.push("Could not confidently identify provider name");
  }

  return result;
}

function extractPatient(
  lines: string[],
  errors: string[]
): ParsedBill["patient"] {
  const result: ParsedBill["patient"] = { name: "" };

  for (const line of lines) {
    const lower = line.toLowerCase();

    if (lower.includes("patient") && lower.includes(":")) {
      const parts = line.split(":");
      if (parts[1]) result.name = parts[1].trim();
    }

    if (lower.includes("member") && lower.includes("id")) {
      const match = line.match(/(?:member\s*(?:id|#)[:\s]*)([\w-]+)/i);
      if (match) result.memberId = match[1];
    }

    if (lower.includes("group") && lower.includes("number")) {
      const match = line.match(/(?:group\s*(?:number|#|no)[:\s]*)([\w-]+)/i);
      if (match) result.groupNumber = match[1];
    }
  }

  if (!result.name) {
    errors.push("Could not extract patient name");
    result.name = "Unknown";
  }

  return result;
}

function extractInsurer(
  lines: string[],
  errors: string[]
): ParsedBill["insurer"] | undefined {
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (
      lower.includes("insurance") ||
      lower.includes("blue cross") ||
      lower.includes("aetna") ||
      lower.includes("cigna") ||
      lower.includes("united") ||
      lower.includes("humana") ||
      lower.includes("kaiser") ||
      lower.includes("anthem")
    ) {
      return { name: line.replace(/[^\w\s&.,-]/g, "").trim() };
    }
  }

  errors.push("Could not identify insurer");
  return undefined;
}

function extractDate(lines: string[], type: string): string | undefined {
  const keywords =
    type === "service"
      ? ["date of service", "service date", "dos", "from date"]
      : ["statement date", "bill date", "date issued"];

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (keywords.some((kw) => lower.includes(kw))) {
      const match = line.match(DATE_PATTERN);
      if (match) return normalizeDate(match[1]);
    }
  }

  // Fallback: find any date in the first 20 lines
  if (type === "service") {
    for (const line of lines.slice(0, 20)) {
      const match = line.match(DATE_PATTERN);
      if (match) return normalizeDate(match[1]);
    }
  }

  return undefined;
}

function normalizeDate(dateStr: string): string {
  if (dateStr.includes("-")) return dateStr; // Already ISO
  const parts = dateStr.split("/");
  if (parts.length === 3) {
    const [m, d, y] = parts;
    const year = y.length === 2 ? `20${y}` : y;
    return `${year}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return dateStr;
}

function extractLineItems(
  lines: string[],
  billType: string,
  errors: string[]
): BillLineItem[] {
  const items: BillLineItem[] = [];
  let lineNumber = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Look for lines with CPT codes and dollar amounts
    const cptMatch = line.match(CPT_PATTERN);
    const dollarMatches = [...line.matchAll(new RegExp(DOLLAR_PATTERN, "g"))];

    if (cptMatch && dollarMatches.length > 0) {
      lineNumber++;
      const procedureCode = cptMatch[1];
      const modifier = cptMatch[2];
      const dateMatch = line.match(DATE_PATTERN);

      // Parse dollar amounts — typically: billed, allowed, insurance paid, patient owes
      const amounts = dollarMatches.map((m) =>
        parseFloat(m[1].replace(/,/g, ""))
      );

      const item: BillLineItem = {
        lineNumber,
        procedureCode,
        procedureCodeType: inferProcedureCodeType(procedureCode),
        modifier,
        description: extractDescription(line, cptMatch.index || 0),
        category: categorizeProcedureCode(procedureCode),
        serviceDate: dateMatch
          ? normalizeDate(dateMatch[1])
          : new Date().toISOString().split("T")[0],
        quantity: 1,
        billedAmount: amounts[0] || 0,
        allowedAmount: amounts.length > 1 ? amounts[1] : undefined,
        insurancePaid: amounts.length > 2 ? amounts[2] : undefined,
        patientResponsibility: amounts.length > 3 ? amounts[3] : undefined,
      };

      // Check for revenue code (hospital bills)
      if (billType === "itemized_bill") {
        const revMatch = line.match(REVENUE_CODE_PATTERN);
        if (revMatch) item.revenueCode = revMatch[1];
      }

      items.push(item);
    }
  }

  if (items.length === 0) {
    errors.push("No line items could be extracted — manual review needed");
  }

  return items;
}

function extractDescription(line: string, codeIndex: number): string {
  // Try to get text between the start and the CPT code
  const before = line.substring(0, codeIndex).trim();
  if (before.length > 5) return before;

  // Or text between CPT code and first dollar amount
  const after = line.substring(codeIndex);
  const dollarIdx = after.search(/\$?\s*[\d,]+\.\d{2}/);
  if (dollarIdx > 0) {
    const desc = after.substring(6, dollarIdx).trim(); // Skip past CPT code
    if (desc.length > 3) return desc;
  }

  return "Medical service";
}

function calculateTotals(lineItems: BillLineItem[]): ParsedBill["totals"] {
  return {
    totalBilled: lineItems.reduce((sum, li) => sum + li.billedAmount, 0),
    totalAllowed: lineItems.some((li) => li.allowedAmount !== undefined)
      ? lineItems.reduce((sum, li) => sum + (li.allowedAmount || 0), 0)
      : undefined,
    totalInsurancePaid: lineItems.some((li) => li.insurancePaid !== undefined)
      ? lineItems.reduce((sum, li) => sum + (li.insurancePaid || 0), 0)
      : undefined,
    totalPatientResponsibility: lineItems.some(
      (li) => li.patientResponsibility !== undefined
    )
      ? lineItems.reduce(
          (sum, li) => sum + (li.patientResponsibility || 0),
          0
        )
      : undefined,
  };
}
