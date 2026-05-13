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

// Plain-English category mapping for common CPT ranges
// No AMA-licensed descriptions — only generic categories
//
// S74 hotfix #3 — prefix corrections for codes that were mis-categorized:
//   - 993XX was labelled "Hospital Care" — it's preventive medicine
//     (99381-99397 periodic preventive E&M).
//   - 904XX, 905XX, 906XX, 907XX (immunization admin + vaccine products)
//     previously fell through to "Medicine — Misc"; now route to explicit
//     Vaccine / Immunization labels.
//   - 913XX (COVID-19 vaccine products, 91300-91322) was missing entirely
//     and fell to "Medicine — Misc"; now routes to "Vaccine — COVID-19".
//
// Bigger flywheel work (Pattern 1 #3 promotion of code+description pairs,
// user category overrides, ACA preventive code registry) lives in the
// next-session subplan; this is the smallest-viable correctness patch.
const CPT_CATEGORIES: Record<string, string> = {
  "992": "Office/Outpatient Visit",
  "993": "Preventive Visit",
  "994": "Consultation",
  "995": "Emergency Department",
  "996": "Critical Care",
  "997": "Inpatient Procedures",
  // 99221-99239 are inpatient hospital E&M codes (prefix 992); kept under
  // Office/Outpatient Visit for now since the prefix table is 3-char wide.
  // The flywheel sprint will subdivide these properly.
  "700": "Radiology — Diagnostic",
  "710": "Radiology — Radiation Therapy",
  "712": "Radiology — Nuclear Medicine",
  "800": "Pathology/Lab",
  "810": "Pathology/Lab",
  "820": "Pathology/Lab",
  "830": "Pathology/Lab",
  "840": "Pathology/Lab",
  "850": "Pathology/Lab",
  "860": "Pathology/Lab",
  "870": "Pathology/Lab",
  "880": "Pathology/Lab",
  "890": "Pathology/Lab",
  "100": "Surgery — Integumentary",
  "200": "Surgery — Musculoskeletal",
  "300": "Surgery — Respiratory/Cardiovascular",
  "400": "Surgery — Digestive",
  "500": "Surgery — Urinary/Reproductive",
  "600": "Surgery — Nervous System/Eye/Ear",
  // Vaccine / immunization (CPT 90471-90756 admin + product) — split out from
  // generic "Medicine — Misc" so /audit + dispute logic can recognize
  // preventive immunizations.
  "904": "Immunization Administration",
  "905": "Vaccine",
  "906": "Vaccine",
  "907": "Vaccine",
  // COVID-19 vaccines (91300-91322) — added post-pandemic; previously absent.
  "913": "Vaccine — COVID-19",
  "900": "Medicine — Misc",
  "960": "Anesthesia",
  "A00": "Transport/DME",
  "J00": "Drug Administration",
  "L00": "Orthotics/Prosthetics",
};

export function categorizeProcedureCode(code: string): string {
  const normalized = code.toUpperCase();

  // CPT Category II reporting codes end in "F" (e.g., 3074F, 3078F). They're
  // $0 quality-reporting placeholders, not billable services. Route them to
  // an explicit label so /audit doesn't surface them as "Surgery —
  // Respiratory/Cardiovascular" (which is what the 3XX prefix would otherwise
  // produce).
  if (/^\d{4}F$/.test(normalized)) {
    return "Quality Reporting (Cat II)";
  }
  // HCPCS Level II G-codes (G0000-G9999) — Medicare-specific quality + admin
  // codes. Most are $0 reporting placeholders. Bigger HCPCS mapping deferred
  // to the categorization flywheel sprint.
  if (/^G\d{4}$/.test(normalized)) {
    return "Medicare Service";
  }

  // Try first 3 digits
  const prefix3 = normalized.substring(0, 3);
  if (CPT_CATEGORIES[prefix3]) return CPT_CATEGORIES[prefix3];

  // Try first 2 digits + "0"
  const prefix2 = normalized.substring(0, 2) + "0";
  if (CPT_CATEGORIES[prefix2]) return CPT_CATEGORIES[prefix2];

  // Try first character + "00"
  const prefix1 = normalized.substring(0, 1) + "00";
  if (CPT_CATEGORIES[prefix1]) return CPT_CATEGORIES[prefix1];

  return "Medical Service";
}

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
