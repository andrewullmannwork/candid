// Core billing data types for Candid audit pipeline

import type { SourceExcerptVerified, ExtractionMethod } from "../parser/types";
// Re-export so existing callers can pull these from billing/types.ts.
export type { SourceExcerptVerified, ExtractionMethod };

// DR-3D Q-DR-3D-2 — EX codes captured with verbatim note text per occurrence.
// Cigna A-codes are positional (same letter, different meaning across EOBs); note_text
// disambiguates downstream via insurer_ex_code_mappings (Phase 5 mig 063).
export interface ExCode {
  code: string; // e.g., "A1", "JU"
  note_text: string; // Verbatim text from EOB Notes section
  note_text_hash?: string; // sha256(normalize(note_text)); set by post-process
}

// DR-3D Q-DR-3D-4 — accumulator entry per (benefit_year, network_tier,
// accumulator_type, is_individual) 4-dim key. Phase 5 mig 061 promotes to table.
export type AccumulatorType = "medical" | "rx" | "dental" | "vision" | "combined" | "mental_health";
export type NetworkTier = "in_network" | "out_of_network" | "tiered" | "unknown";

export interface Accumulator {
  benefit_year: string; // Calendar year of service_date (NOT plan year)
  network_tier: NetworkTier;
  accumulator_type: AccumulatorType; // Default 'combined' if EOB doesn't distinguish
  is_individual: boolean; // true=individual; false=family aggregate
  deductible_applied?: number;
  deductible_max?: number;
  oop_applied?: number;
  oop_max?: number;
  copays_applied?: number;
  coinsurance_applied?: number;
}

// DR-3D Q-DR-3D-6 — Haiku per-field confidence METADATA per Q-DR-3B-1.
// NOT auto-blended into Pattern 1 score; consumed by Phase 6 calibration.
//
// Pattern P-8 (Phase 3.1B) extends this with per-field source provenance:
// `fieldProvenance` carries source_excerpt + verification + section_hint per field.
// `fieldConfidences` retained for backcompat with existing readers; populated from
// fieldProvenance.{field}.confidence as a convenience projection.
export interface EOBExtractionMeta {
  fieldConfidences: Record<string, number>; // dot-path key → 0..1 (backcompat projection of fieldProvenance.confidence)
  fieldProvenance: Record<string, FieldMeta>; // Pattern P-8 — full per-field meta (citation-grade source provenance)
  warnings: string[]; // Defensive-handler observations from parseHaikuMetaBlock + verifySourceExcerpts
}

/**
 * Pattern P-8 per-field metadata. Stored as JSONB sub-keys under
 * `field_provenance.{field}` after `buildLineItemProvenance` writes.
 *
 * `source_section_hint` is parser-specific (EOB enum lives in eob-postprocess.ts;
 * SBC/EOC/formulary parsers will define their own). Stored as opaque string in JSONB;
 * consumers format via `formatSectionHint()` in `src/lib/parser/source-display.ts`.
 *
 * `source_excerpt_verified` is a 3-state enum per Q-P3.1B-6 v2 — no fuzzy matching.
 */
export interface FieldMeta {
  confidence?: number; // 0-1, Haiku self-reported (METADATA only per Q-DR-3B-1)
  source_excerpt?: string; // ≤200 chars verbatim from doc; Pattern P-8
  source_excerpt_verified?: SourceExcerptVerified; // 'verified' | 'not_found' | 'ocr_unverifiable'
  source_excerpt_extraction_method?: ExtractionMethod; // 'pdftotext' | 'native_pdf_text' | 'ocr'
  source_section_hint?: string; // parser-specific section enum value (string in JSONB)
  source_section_verified?: boolean; // excerpt appears within named section's text-range
}

export type ClaimLineStatus = "paid" | "not_paid" | "pending" | "denied" | "adjusted";
export type ProcedureCodeType = "CPT" | "HCPCS_L2" | "REV" | "DRG" | "NDC" | "G_CODE" | "CAT_II";

export interface BillLineItem {
  lineNumber: number;
  procedureCode: string; // CPT or HCPCS code (5-digit)
  procedureCodeType?: ProcedureCodeType; // DR-3D Task 3F discriminator
  revenueCode?: string; // 4-digit revenue code (hospital bills)
  description: string; // Raw description from the bill
  category: string; // Plain-English category (no CPT descriptions)
  serviceDate: string; // ISO date
  quantity: number;
  billedAmount: number; // What provider charged
  allowedAmount?: number; // What insurance says is reasonable
  insurancePaid?: number; // What insurance ACTUALLY paid to the provider (NOT the contractual writeoff — that's ins_adjusted)
  patientResponsibility?: number; // Total user share assigned by insurer (lump sum; superseded by member_* when EOB decomposes). NOT the remaining balance — see patient_paid for what user has paid OOP.
  patient_paid?: number; // What the patient has paid out of pocket on this line. Distinct from patientResponsibility (= total assigned share). Parser extracts from "Paid [date] -$X" footer lines on settled bills.
  adjustments?: number; // Write-offs / contractual adjustments
  modifier?: string; // CPT modifier (e.g., "25" for separate E/M)

  // DR-3D EOB-specific extensions (all optional; populated by EOB parser only)
  line_number_in_eob?: string; // Verbatim e.g. "0100"; preserves EOB ordering
  paid_date?: string; // ISO date
  claim_line_status?: ClaimLineStatus;
  denied_amount?: number; // Distinct from $0 paid; explicitly DENIED portion
  contract_discount?: number; // Insurer-negotiated discount, NOT bundled into adjustments
  ins_adjusted?: number; // Task 3F: split from generic adjustments
  provider_adjusted?: number; // Task 3F: split from generic adjustments
  cob_allowed?: number; // Coordination of Benefits
  cob_paid?: number;
  cob_payer_id?: string;
  tax_paid?: number;
  interest_paid?: number;
  member_copay?: number; // Decomposed from patientResponsibility
  member_coinsurance?: number;
  member_applied_to_deductible?: number;
  network_status?: NetworkTier;
  carc_codes?: string[]; // CMS X12 enumerated; lookup via carc_dictionary (mig 062)
  rarc_codes?: string[]; // CMS X12 enumerated; lookup via rarc_dictionary (mig 062)
  ex_codes?: ExCode[]; // Insurer-specific; mapped via insurer_ex_code_mappings (mig 063)
  is_adjustment_reversal?: boolean; // Set by post-process detectReversalCycles
  adjusts_line_id?: string; // FK to original line; set by post-process

  // Task 3F: rendering provider (per-line; distinct from facility-level provider on ParsedBill)
  rendering_provider_npi?: string;
  rendering_provider_name?: string;

  // S74.6 §C.1 D3 — pre-flight slug resolution. Set by
  // `resolveLineItemSlugs` (called BEFORE runAudit) so cohort accuracy
  // adjustment can build (rule, insurer, slug) keys + D4 description-match
  // skips lines that already have a slug. Persist consumes these fields
  // instead of re-running service-mapper. Reaudit + dispute-rerun populate
  // via `applyPersistedSlugs` reading claim_line_items.service_slug.
  serviceSlug?: string | null;
  serviceSlugSource?:
    | "cached_mapping"
    | "service_mapper"
    | "flywheel_identity"
    | "persisted"
    | null;
  billingCodeIdentityId?: string | null;
}

export interface ParsedBill {
  id: string;
  documentId: string; // References documents table
  userId: string;
  billType: "eob" | "itemized_bill";
  provider: {
    name: string;
    npi?: string; // National Provider Identifier (facility-level)
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
    accountNumber?: string;
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
    totalDenied?: number; // DR-3D
    totalContractDiscount?: number; // DR-3D
    totalInsAdjusted?: number; // Task 3F: split — contractual writeoff total (NOT insurance payment)
    totalProviderAdjusted?: number; // Task 3F: split
    totalPatientPaid?: number; // Sum of "Paid [date] -$X" footer lines; what the user has paid OOP across all line items. Distinct from totalPatientResponsibility (= total assigned share).
  };
  rawText: string; // Full OCR text for reference
  confidence: number; // 0-1, OCR extraction confidence
  parseErrors: string[]; // Any fields that couldn't be extracted

  // DR-3D EOB-specific extensions (optional; populated by EOB parser only)
  external_claim_number?: string; // Insurer's claim ID
  eob_date?: string; // Date EOB was generated (distinct from service_date)
  network_status?: NetworkTier;
  accumulators?: Accumulator[];
  extractionMeta?: EOBExtractionMeta; // Q-DR-3D-6 per-field confidence + warnings
}

// Audit findings

export type FindingType =
  | "overcharge" // Billed above benchmark
  | "duplicate" // Same code, same date, same provider
  | "unbundling" // Codes that should be bundled
  | "upcoding" // Higher-complexity code than warranted
  | "balance_billing" // Billing beyond allowed amount (illegal in some states)
  | "missing_adjustment" // Insurance adjustment not applied
  | "stale_claim" // Claim filed after timely filing deadline
  | "zero_cost_share_overcharge" // S74.5 D13 — code is ACA preventive or ACIP vaccine; should be $0 patient cost
  | "unallocated_balance" // S74.5 D15 — bill header patient_resp exceeds SUM(line patient_resp); ask for itemization
  | "insurance_underpayment" // F-14 (Session 85) — service covered by plan but insurer paid $0 (writeoff applied but claim never processed)
  | "code_uncategorized_description_match" // S74.6 D4 — code lacks a slug; Haiku description-match suggests a provisional slug ≥0.85 score
  | "uncategorized_service"; // S74.6 D4 — code lacks a slug AND Haiku description-match top score < 0.85 (soft "review or correct" finding)

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
  confidence: number; // 0-1 (possibly cohort-adjusted; see accuracy-cohort-loader)
  actionable: boolean; // Whether a dispute letter can be generated
  // S74.6 D3 — surfaced when cohort win-rate is in the informational tier
  // (0.2 <= win_rate < 0.5 AND n >= 10). UI renders alongside the amber
  // finding card so users have honest signal without being discouraged from
  // disputing. Null/undefined → no chip (boost / baseline tiers).
  cohortAccuracyChip?: string | null;
  // S74.6 D4 §D.1 + §D.2 — description-match metadata for persist-time flywheel
  // writes (recordDescriptionMatchVote / recordAmbiguousCandidate). Populated
  // only on `code_uncategorized_description_match` findings emitted from the
  // D4 audit rule. Persist reads this AFTER claim_line_items.INSERT so it can
  // pass the now-existing line_item_id to the vote-recording helpers.
  descriptionMatch?: {
    provisionalSlug: string;
    haikuScore: number;
    ambiguous: boolean;
    secondMatch?: { slug: string; score: number } | null;
  };
}

// Persisted shape on claim.metadata.auditSummary.claimLevelFindings.
// Mirrors the minimal shape that gets written to claim_line_items.metadata.auditFindings
// for line-level findings (so consumers can dismiss via the unified endpoint
// regardless of attachment).
export interface ClaimLevelFindingMeta {
  id: string;
  type: FindingType;
  severity: FindingSeverity;
  estimatedOvercharge: number;
  title: string;
  description?: string;
  benchmarkSource?: string;
  actionable: boolean;
  dismissed?: boolean;
  dismissed_at?: string;
  dismissed_reason?: string;
  dismissed_note?: string | null;
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
    // S74.5c §1.7 — claim-header findings (lineItems: []) persisted here so
    // they survive the reaudit write loop (which keys by lineNumber) and are
    // available to ClaimDetail's claim-level findings render section + the
    // dismiss-finding endpoint's claim-level fallback branch.
    claimLevelFindings?: ClaimLevelFindingMeta[];
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
