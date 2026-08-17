/** Generated types — replace with `supabase gen types typescript` output after migration. */

// ── Enum Types ─────────────────────────────────────────────────────────────────

export type ConsentType =
  | "tos"
  | "privacy_policy"
  | "health_data_upload"
  | "marketplace_data_sharing"
  | "aggregate_data_monetization";

export type SubscriptionStatus =
  | "none"
  | "trialing"
  | "active"
  | "canceled"
  | "past_due";

export type DocType = "eob" | "itemized_bill" | "insurance_card" | "sbc" | "other";
export type DocStatus = "uploaded" | "processing" | "processed" | "queued" | "error" | "pending_review" | "rejected" | "needs_review";

export type InsurancePlanSource =
  | "sbc_upload"
  | "plan_doc_upload"
  | "catalog_match"
  | "manual"
  | "insurance_card";

export type VerificationStatus =
  | "unverified"
  | "document_verified"
  | "user_confirmed"
  | "cms_matched"
  | "multi_user_verified";

export type PlaceOfService =
  | "pcp_office"
  | "specialist_office"
  | "outpatient_facility"
  | "inpatient_facility"
  | "independent_facility"
  | "home"
  | "virtual"
  | "retail_pharmacy"
  | "home_delivery_pharmacy"
  | "designated_pharmacy"
  | "any";

export type ServiceCategory =
  | "office_visit"
  | "emergency"
  | "hospital"
  | "imaging"
  | "lab"
  | "rx"
  | "therapy"
  | "mental_health"
  | "maternity"
  | "dme"
  | "preventive"
  | "other"
  // S167 Thesaurus (Pattern S; migs 147/148): mirror the live service_categories (20 total).
  // All additive (Rule #7); existing values retained — deprecate-not-drop (frontend reads them, §R.4).
  // 'general'/'other'/'hospital' are now empty vestigial catch-alls; the 6 domains below are this build.
  | "long_term_care"
  | "general"
  | "dental"
  | "vision"
  | "surgery"
  | "hospitalization"
  | "dialysis"
  | "family_planning";

export type CoveredServiceSource = "sbc_parsed" | "plan_doc_parsed" | "cms_data" | "manual" | "canonical_inherited";

export type BillingCodeType = "CPT" | "HCPCS" | "ICD10" | "REV" | "NDC" | "DRG" | "unknown";

export type ClaimStatus = "pending" | "processed" | "flagged" | "denied" | "appealed";

// ── Table Types ────────────────────────────────────────────────────────────────

// Users
export interface UserRow {
  id: string;
  firebase_uid: string;
  email: string;
  display_name: string | null;
  is_admin: boolean;
  created_at: string;
  // mig 166 — set on CHD erasure (consent revoke / pre account-delete), cleared
  // on re-grant. Gates parse-persist via the erasure_write_guard trigger.
  chd_erased_at: string | null;
  // mig 229 (S315) — anonymous bill-check account; users.email holds a
  // synthetic per-uid placeholder while true. Flipped false by the upgrade sync.
  is_anonymous: boolean;
  // mig 229 (S315) — typed results/deletion contact for anonymous checks.
  // Never identity (account-link keys on the token email). Cleared on upgrade.
  contact_email: string | null;
}

// Profiles
export interface ProfileRow {
  id: string;
  user_id: string;
  insurer: string | null;
  plan_type: string | null;
  state: string | null;
  primary_concern: string | null;
  // Plan fields (deprecated — use insurance_plans)
  plan_name: string | null;
  group_number: string | null;
  member_id: string | null;
  deductible_individual: number | null;
  oop_max_individual: number | null;
  copay_primary: number | null;
  copay_specialist: number | null;
  copay_er: number | null;
  coinsurance_pct: number | null;
  insurance_card_path: string | null;
  // Demographics
  date_of_birth: string | null;
  sex: "male" | "female" | "prefer_not_to_say" | null;
  phone: string | null;
  dependents: unknown; // JSONB: [{ name, relationship, date_of_birth, sex, on_same_plan }]
  // Address / county (migration 026)
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  zip_code: string | null;
  county_fips: string | null;
  county_name: string | null;
  // Simplified onboarding (migration 208)
  household: "just_me" | "me_spouse" | "me_kids" | "me_spouse_kids" | null;
  situation_tags: string[] | null;
  // Plan matching (deprecated — use insurance_plans)
  matched_plan_id: string | null;
  plan_source: string | null;
  // New: active insurance plan
  active_insurance_plan_id: string | null;
  created_at: string;
  updated_at: string;
}

// Documents
export interface DocumentRow {
  id: string;
  user_id: string;
  storage_path: string;
  file_name: string;
  file_size: number;
  doc_type: DocType;
  consent_event_id: string;
  status: DocStatus;
  // Classification (migration 009)
  classified_type: string | null;
  classification_confidence: number | null;
  classification_signals: unknown | null; // JSONB
  type_mismatch: boolean;
  linked_insurance_plan_id: string | null;
  // Processing state (migration 016)
  processing_step: string | null;
  processing_total_pages: number | null;
  processing_completed_pages: number | null;
  processing_ocr_text: string | null;
  processing_started_at: string | null;
  processing_error: string | null;
  // Mismatch (migration 017)
  insurer_mismatch: Record<string, unknown> | null;
  // Dedup (migration 027)
  file_hash: string | null;
  // Reprocessing (migration 028)
  retry_count: number;
  // ID-Block content fingerprint (migration 155) — re-save-invariant 16-char simhash hex; NULL until computed (pre-existing rows / non-plan-doc types)
  content_fingerprint: string | null;
  created_at: string;
}

// Service Catalog
export interface ServiceCatalogRow {
  id: string;
  slug: string;
  name: string;
  category: ServiceCategory;
  description: string | null;
  is_preventive_eligible: boolean;
  commonly_disputed: boolean;
  dispute_rate: number;
  misbill_rate: number;
  denial_rate: number;
  avg_overcharge_pct: number;
  created_at: string;
  updated_at: string;
}

// Insurance Plans
export interface InsurancePlanRow {
  id: string;
  user_id: string;
  // Identity
  plan_name: string | null;
  insurer_name: string | null;
  employer_name: string | null;
  plan_type: string | null;
  plan_year: number | null;
  state: string | null;
  group_number: string | null;
  member_id: string | null;
  coverage_period_start: string | null;
  coverage_period_end: string | null;
  coverage_tier: string | null;
  // In-network
  in_deductible_individual: number | null;
  in_deductible_family: number | null;
  in_oop_max_individual: number | null;
  in_oop_max_family: number | null;
  in_coinsurance_default: number | null;
  // Out-of-network
  out_deductible_individual: number | null;
  out_deductible_family: number | null;
  out_oop_max_individual: number | null;
  out_oop_max_family: number | null;
  out_coinsurance_default: number | null;
  // Premium
  premium_total: number | null;
  premium_employee: number | null;
  premium_employer: number | null;
  premium_subsidy: number | null;
  premium_frequency: string | null;
  // Plan rules
  deductible_calc_method: "embedded" | "aggregate" | null;
  combined_medical_rx_oop: boolean | null;
  oop_exclusions: unknown | null; // JSONB
  other_deductibles: unknown | null; // JSONB
  referral_required: boolean | null;
  network_name: string | null;
  mail_order_pharmacy: boolean | null;
  coordination_type: "primary" | "secondary" | "unknown" | null;
  // Claims & appeals
  timely_filing_days_in: number | null;
  timely_filing_days_out: number | null;
  appeals_deadline_days: number | null;
  external_review_available: boolean | null;
  claims_timelines: unknown | null; // JSONB
  contact_info: unknown | null; // JSONB
  // Admin / ERISA
  admin_info: unknown | null; // JSONB
  // Continuation
  cobra_months: number | null;
  medical_benefits_extension: boolean | null;
  // Compliance
  minimum_essential_coverage: boolean | null;
  minimum_value_standard: boolean | null;
  // Provenance
  source: InsurancePlanSource;
  source_document_id: string | null;
  matched_catalog_plan_id: string | null;
  hios_id: string | null; // migration 026 — links to plan_catalog county variant
  confidence: number;
  // Verification
  verification_status: VerificationStatus;
  verification_count: number;
  cms_match_confidence: number | null;
  // Status
  is_active: boolean;
  verified_by_user: boolean;
  created_at: string;
  updated_at: string;
}

export type InsurancePlanInsert = Partial<InsurancePlanRow> & {
  user_id: string;
};

// Plan Covered Services
export interface PlanCoveredServiceRow {
  id: string;
  insurance_plan_id: string;
  service_id: string;
  place_of_service: PlaceOfService;
  // In-network
  in_copay: number | null;
  in_coinsurance: number | null;
  in_deductible_applies: boolean | null;
  in_copay_waiver_condition: string | null;
  in_cost_description: string | null;
  // Out-of-network
  out_copay: number | null;
  out_coinsurance: number | null;
  out_deductible_applies: boolean | null;
  out_cost_description: string | null;
  // Rules
  oon_paid_at_in_network: boolean;
  annual_limit: string | null;
  annual_limit_value: number | null;
  prior_auth_required: boolean | null;
  penalty_no_precert: number | null;
  covered: boolean;
  coverage_conditions: string | null;
  exclusion_reason: string | null;
  // Rx-specific
  supply_limit_days: number | null;
  home_delivery_copay: number | null;
  specialty_pharmacy_required: boolean | null;
  step_therapy_required: boolean | null;
  quantity_limit: string | null;
  designated_pharmacy_required: boolean | null;
  ancillary_charge_applies: boolean | null;
  // Other
  multiple_surgery_reduction: boolean | null;
  notes: string | null;
  // Provenance
  confidence: number;
  source: CoveredServiceSource;
  created_at: string;
}

export type PlanCoveredServiceInsert = Partial<PlanCoveredServiceRow> & {
  insurance_plan_id: string;
  service_id: string;
};

// Claims (encounter-level records)
export interface ClaimRow {
  id: string;
  user_id: string;
  insurance_plan_id: string | null;
  provider_id: string | null;
  date_of_service: string | null;
  place_of_service: string | null;
  total_billed: number | null;
  total_allowed: number | null;
  total_insurance_paid: number | null;
  total_patient_responsibility: number | null;
  diagnosis_codes: string[];
  source_document_id: string | null;
  claim_number: string | null;
  status: ClaimStatus;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// Claim Line Items (per-charge billing detail)
export interface ClaimLineItemRow {
  id: string;
  claim_id: string;
  line_number: number | null;
  concept_id: string | null;
  billing_code: string | null;
  billing_code_type: BillingCodeType | null;
  service_slug: string | null;
  description: string | null;
  units: number;
  billed_amount: number | null;
  allowed_amount: number | null;
  insurance_paid: number | null;
  patient_owes: number | null;
  adjustment_reason_code: string | null;
  adjustment_reason_description: string | null;
  modifier_codes: string[] | null;
  place_of_service_code: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// Claim Insights
export interface ClaimInsightRow {
  id: string;
  service_id: string;
  insurer_name: string;
  total_claims_seen: number;
  denial_count: number;
  overcharge_count: number;
  avg_overcharge_amount: number;
  avg_overcharge_pct: number;
  dispute_filed_count: number;
  dispute_success_count: number;
  most_common_error_type: string | null;
  updated_at: string;
}

// ── Legacy Database type (kept for backwards compat with existing code) ────────

export type Database = {
  public: {
    Tables: {
      users: {
        Row: UserRow;
        Insert: Partial<UserRow> & { firebase_uid: string; email: string };
        Update: { display_name?: string | null; email?: string; chd_erased_at?: string | null };
      };
      profiles: {
        Row: ProfileRow;
        Insert: Partial<ProfileRow> & { user_id: string };
        Update: Partial<ProfileRow>;
      };
      waitlist: {
        Row: {
          id: string;
          email: string;
          source: string | null;
          referral_code: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          email: string;
          source?: string | null;
          referral_code?: string | null;
        };
        Update: never;
      };
      documents: {
        Row: DocumentRow;
        Insert: Partial<DocumentRow> & {
          user_id: string;
          storage_path: string;
          file_name: string;
          file_size: number;
          doc_type: DocType;
          consent_event_id: string;
        };
        Update: Partial<DocumentRow>;
      };
      consent_events: {
        Row: {
          id: string;
          user_id: string | null;
          email: string | null;
          consent_type: ConsentType;
          consent_version: string;
          consent_text_hash: string;
          granted: boolean;
          ip_address: string | null;
          user_agent: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          email?: string | null;
          consent_type: ConsentType;
          consent_version: string;
          consent_text_hash: string;
          granted: boolean;
          ip_address?: string | null;
          user_agent?: string | null;
        };
        Update: never;
      };
      stripe_customers: {
        Row: {
          id: string;
          user_id: string;
          stripe_customer_id: string;
          subscription_status: SubscriptionStatus;
          subscription_tier: "free" | "pro";
          current_period_end: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          stripe_customer_id: string;
          subscription_status?: SubscriptionStatus;
          subscription_tier?: "free" | "pro";
          current_period_end?: string | null;
        };
        Update: {
          subscription_status?: SubscriptionStatus;
          subscription_tier?: "free" | "pro";
          current_period_end?: string | null;
        };
      };
      site_copy: {
        Row: {
          id: string;
          key: string;
          value: string;
          section: string;
          description: string | null;
          updated_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          key: string;
          value: string;
          section?: string;
          description?: string | null;
          updated_by?: string | null;
        };
        Update: {
          value?: string;
          section?: string;
          description?: string | null;
          updated_by?: string | null;
        };
      };
      support_tickets: {
        Row: {
          id: string;
          user_id: string | null;
          email: string;
          subject: string;
          body: string;
          status: "open" | "in_progress" | "resolved" | "closed";
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          email: string;
          subject: string;
          body: string;
          status?: "open";
        };
        Update: {
          status?: "open" | "in_progress" | "resolved" | "closed";
        };
      };
      service_catalog: {
        Row: ServiceCatalogRow;
        Insert: Partial<ServiceCatalogRow> & { slug: string; name: string; category: ServiceCategory };
        Update: Partial<ServiceCatalogRow>;
      };
      insurance_plans: {
        Row: InsurancePlanRow;
        Insert: InsurancePlanInsert;
        Update: Partial<InsurancePlanRow>;
      };
      plan_covered_services: {
        Row: PlanCoveredServiceRow;
        Insert: PlanCoveredServiceInsert;
        Update: Partial<PlanCoveredServiceRow>;
      };
      claim_insights: {
        Row: ClaimInsightRow;
        Insert: Partial<ClaimInsightRow> & { service_id: string; insurer_name: string };
        Update: Partial<ClaimInsightRow>;
      };
      benefit_corrections: {
        Row: BenefitCorrectionRow;
        Insert: BenefitCorrectionInsert;
        Update: Partial<BenefitCorrectionRow>;
      };
    };
  };
};

// ── Benefit Corrections ──────────────────────────────────────────────────────

export type CorrectionField = "copay" | "coinsurance" | "covered" | "prior_auth" | "deductible_applies" | "annual_limit" | "other";
export type CorrectionStatus = "pending" | "approved" | "rejected" | "applied";

export interface BenefitCorrectionRow {
  id: string;
  user_id: string;
  insurance_plan_id: string | null;
  canonical_plan_id: string | null;
  service_slug: string;
  field: CorrectionField;
  old_value: string | null;
  proposed_value: string;
  notes: string | null;
  evidence_document_id: string | null;
  status: CorrectionStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  created_at: string;
  updated_at: string;
}

export type BenefitCorrectionInsert = Omit<BenefitCorrectionRow, "id" | "status" | "reviewed_by" | "reviewed_at" | "review_notes" | "created_at" | "updated_at"> & {
  status?: CorrectionStatus;
};

// ── Billing Code Intelligence ────────────────────────────────────────────────

export interface BillingCodeMappingRow {
  id: string;
  billing_code: string;
  billing_code_type: string;
  service_slug: string;
  confidence: number;
  observation_count: number;
  provider_descriptions: string[];
  first_seen_at: string;
  last_seen_at: string;
}

export interface BillingCodePlanOutcomeRow {
  id: string;
  billing_code: string;
  billing_code_type: string;
  canonical_plan_id: string;
  total_claims: number;
  paid_count: number;
  denied_count: number;
  avg_paid_amount: number | null;
  avg_billed_amount: number | null;
  common_denial_reasons: string[];
  updated_at: string;
}

// ── Claim Discrepancies ──────────────────────────────────────────────────────

export type DiscrepancyTier = 1 | 2 | 3;

export type DiscrepancyField =
  | "copay"
  | "coinsurance"
  | "coverage"
  | "deductible"
  | "allowed_amount"
  | "coverage_status"
  | "unknown_service"
  | "code_substitution"
  | "other";

export type DiscrepancyStatus = "flagged" | "ignored" | "verifying" | "disputed" | "resolved";

export type DiscrepancySource =
  | "user_plan"
  | "canonical_plan"
  | "canonical_network"
  | "bill_observed"
  | "audit_rule"
  | "code_intelligence";

export interface ClaimDiscrepancyRow {
  id: string;
  claim_id: string;
  claim_line_item_id: string;
  user_id: string;
  service_slug: string;
  tier: DiscrepancyTier;
  field: DiscrepancyField;
  expected_value: string;
  actual_value: string;
  expected_source: DiscrepancySource;
  expected_confidence: number;
  status: DiscrepancyStatus;
  is_systemic: boolean;
  systemic_user_count: number | null;
  resolved_dispute_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ── Plan Covered Services (bill-observed extensions) ─────────────────────────

/** Additional columns on plan_covered_services from migration 035 */
export interface PlanCoveredServiceBillObserved {
  bill_observed_cost: number | null;
  bill_observed_count: number;
  bill_observed_source: string | null;
  bill_observed_updated_at: string | null;
}

// ── Dispute Follow-ups (migration 038) ──────────────────────────────────────

export type FollowupType = "initial_30d" | "reprompt_14d" | "final" | "post_escalation_60d" | "post_escalation_reprompt_30d";
export type FollowupStatus = "pending" | "shown" | "dismissed" | "acted";
export type EscalationType = "case" | "small_claims" | "external_appeal";

// ── Accuracy Scoring (migration 039) ────────────────────────────────────────

export interface AuditRuleAccuracyRow {
  id: string;
  rule_type: string;
  insurer_name: string;
  service_slug: string;
  total_disputes: number;
  won_count: number;
  settled_count: number;
  lost_count: number;
  total_recovered: number;
  avg_recovered_pct: number | null;
  created_at: string;
  updated_at: string;
}

export interface ProviderAuditMetricsRow {
  id: string;
  provider_id: string;
  total_bills_analyzed: number;
  finding_count: number;
  finding_rate: number;
  finding_types: Record<string, unknown>;
  updated_at: string;
}

export interface DisputeFollowupRow {
  id: string;
  dispute_id: string;
  user_id: string;
  followup_type: FollowupType;
  due_date: string;
  status: FollowupStatus;
  escalation_type: EscalationType | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
