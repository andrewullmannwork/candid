// Core billing data types for Candid audit pipeline

export interface BillLineItem {
  lineNumber: number;
  procedureCode: string; // CPT or HCPCS code (5-digit)
  revenueCode?: string; // 4-digit revenue code (hospital bills)
  description: string; // Raw description from the bill
  category: string; // Plain-English category (no CPT descriptions)
  serviceDate: string; // ISO date
  quantity: number;
  billedAmount: number; // What provider charged
  allowedAmount?: number; // What insurance says is reasonable
  insurancePaid?: number; // What insurance paid
  patientResponsibility?: number; // What patient owes
  adjustments?: number; // Write-offs / contractual adjustments
  modifier?: string; // CPT modifier (e.g., "25" for separate E/M)
}

export interface ParsedBill {
  id: string;
  documentId: string; // References documents table
  userId: string;
  billType: "eob" | "itemized_bill";
  provider: {
    name: string;
    npi?: string; // National Provider Identifier
    taxId?: string;
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
  serviceDate: string; // Primary date of service
  statementDate?: string; // Date bill was generated
  lineItems: BillLineItem[];
  totals: {
    totalBilled: number;
    totalAllowed?: number;
    totalInsurancePaid?: number;
    totalPatientResponsibility?: number;
    totalAdjustments?: number;
  };
  rawText: string; // Full OCR text for reference
  confidence: number; // 0-1, OCR extraction confidence
  parseErrors: string[]; // Any fields that couldn't be extracted
}

// Audit findings

export type FindingType =
  | "overcharge" // Billed above benchmark
  | "duplicate" // Same code, same date, same provider
  | "unbundling" // Codes that should be bundled
  | "upcoding" // Higher-complexity code than warranted
  | "balance_billing" // Billing beyond allowed amount (illegal in some states)
  | "missing_adjustment" // Insurance adjustment not applied
  | "stale_claim"; // Claim filed after timely filing deadline

export type FindingSeverity = "low" | "medium" | "high" | "critical";

export interface AuditFinding {
  id: string;
  type: FindingType;
  severity: FindingSeverity;
  lineItems: number[]; // lineNumber references
  title: string; // e.g., "Potential overcharge on lab work"
  description: string; // Plain-English explanation
  estimatedOvercharge: number; // Dollar amount
  benchmarkSource: string; // "CMS PPL" | "FAIR Health" | "Internal"
  benchmarkAmount?: number; // What the benchmark says it should cost
  billedAmount: number; // What was actually billed
  confidence: number; // 0-1
  actionable: boolean; // Whether a dispute letter can be generated
}

export interface AuditReport {
  id: string;
  documentId: string;
  userId: string;
  parsedBill: ParsedBill;
  findings: AuditFinding[];
  summary: {
    totalFindings: number;
    totalEstimatedOvercharge: number;
    highSeverityCount: number;
    actionableCount: number;
  };
  createdAt: string;
}

// CMS PPL API types

export interface CMSPPLRate {
  procedureCode: string;
  modifier?: string;
  nationalAverage: number;
  locality?: string;
  localRate?: number;
  year: number;
  source: "cms_ppl";
}

// Dispute letter types

export type DisputeLetterType =
  | "overcharge" // General overcharge dispute
  | "itemized_request" // Request for itemized bill
  | "insurance_appeal" // Insurance denial appeal
  | "balance_billing" // Balance billing complaint
  | "duplicate_charge" // Duplicate charge dispute
  | "negotiation"; // Self-pay / uninsured rate negotiation

export interface DisputeLetter {
  id: string;
  auditReportId: string;
  userId: string;
  letterType: DisputeLetterType;
  findingIds: string[]; // Which findings this letter addresses
  recipient: {
    name: string;
    role: string; // "Billing Department" | "Insurance Appeals" etc.
    address?: string;
    phone?: string;
  };
  subject: string;
  body: string; // Full letter text
  supportingFacts: string[]; // Extracted from audit findings
  legalBasis?: string; // Applicable law/regulation
  requestedAction: string; // What the user is asking for
  status: "draft" | "approved" | "downloaded";
  createdAt: string;
  updatedAt: string;
  // Phase 1 additions — planContext populated by /api/disputes routes when
  // insurancePlanId or claimId is provided. Consumed by DisputeRecipientCard
  // + evidence-resolver. Optional so existing callers stay compatible.
  planContext?: {
    planName: string | null;
    planYear: number | null;
    insurerName: string | null;
  } | null;
  // Phase 3: flagged when the claim's plan year has no matching insurance_plans
  // row. UI surfaces MissingPlanBanner + download warning modal.
  missingPlanForYear?: number | null;
}
