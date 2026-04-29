/**
 * Candid Care — interface contract (v1).
 *
 * Type signatures + read-function stubs for the Care service surface.
 * Implementations land in Phase 4 (per master_data_pipeline_hardening); v1 stubs
 * throw at runtime so unwired callers fail loudly.
 *
 * Design Review: plans/findings/design_review_1B.3_care_interface.md (vault).
 * Inputs: care_case_forward_compat_audit §6, Candid_Schema_Reference, Candid_Data_Patterns.
 *
 * Three layers:
 *   1. Provider             — schema entity, 1:1 with `providers` table
 *   2. Facility / Doctor    — composed query results, layered on Provider
 *   3. Sub-types            — one per concern (pricing, quality, community, etc.)
 *
 * Forward-compat rules (locked in Design Review §7):
 *   - Nullable struct fields, not optional
 *   - Sub-types extend by additive fields only
 *   - Empty-state reasons are an enum (exhaustive switch)
 *   - New input params are optional
 *   - Phase-gated comments mark unwired sub-types
 */

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

/**
 * k-anonymity thresholds gating defamation-exposed surfaces.
 *
 * Changes require legal review — these numbers determine when a community-derived
 * statistic about a named party (hospital, doctor, lawyer) is suppressed because
 * the sample is too small to be fair. Per Q4 + Q5 locked Session 39.
 */
export const K_ANON_THRESHOLDS = {
  ratings: 5,
  dispute_success: 10,
  reimbursement_frequency: 15,
  billing_error_rate: 20,
  unspecified_reference: 5,
} as const;

// ----------------------------------------------------------------------------
// Layer 1: Provider entity (1:1 with `providers` table)
// ----------------------------------------------------------------------------

export type ProviderType =
  | "hospital"
  | "clinic"
  | "urgent_care"
  | "physician_group"
  | "pharmacy"
  | "lab"
  | "individual";

export interface Provider {
  id: string;
  npi: string | null;
  provider_type: ProviderType;
  display_name: string;
  organization_name: string | null;
  specialty: string | null;

  address: string | null;
  address_city: string | null;
  address_state: string | null;
  address_zip: string | null;

  phone: string | null;

  latitude: number | null;
  longitude: number | null;

  health_system: string | null;

  is_active: boolean;
  nppes_updated_at: string | null;
}

// ----------------------------------------------------------------------------
// Layer 3: Domain sub-types (defined before Layer 2 composed types use them)
// ----------------------------------------------------------------------------

// --- Confidence + provenance ------------------------------------------------

export type SourceProvenance =
  | "admin_verified"
  | "multi_source_corroboration"
  | "doc_extraction"
  | "card_corroboration"
  | "cms_marketplace"
  | "cms_medicare"
  | "cms_medicaid"
  | "sbe_ingest"
  | "user_correction"
  | "user_initial_entry"
  | "peo_inference"
  | "bill_observed"
  | "provider_submitted"
  | "nppes"
  | "irs_990_h"
  | "state_filing"
  | "legacy";

export interface ConfidenceMeta {
  confidence: 0.5 | 0.7 | 0.9 | 1.0;
  source: SourceProvenance;
  observation_count: number | null;
  last_verified_at: string | null;
}

// --- Facility attributes (Phase 6 wires CMS POS data; v1 returns nulls) -----

export type HospitalOwnership =
  | "for_profit"
  | "non_profit"
  | "government"
  | "physician_owned";

export type TraumaLevel =
  | "level_1"
  | "level_2"
  | "level_3"
  | "level_4"
  | "level_5"
  | "non_trauma";

/** Phase 6 wires CMS POS ingest. v1 returns all fields null. */
export interface FacilityAttributes {
  ownership: HospitalOwnership | null;
  bed_count: number | null;
  teaching_hospital: boolean | null;
  trauma_level: TraumaLevel | null;
}

// --- Network status ---------------------------------------------------------

export type InNetworkStatus =
  | "in_network"
  | "out_of_network"
  | "tier1"
  | "tier2"
  | "unknown";

export type NetworkSource =
  | "plan_document"
  | "cms_api"
  | "mrf"
  | "user_report";

export interface NetworkStatus {
  in_network: InNetworkStatus;
  network_tier: string | null;
  source: NetworkSource;
  last_verified_at: string | null;
  effective_date: string | null;
  termination_date: string | null;
}

// --- Pricing aggregates -----------------------------------------------------

export type CoverageStatusAtDos =
  | "insured_commercial"
  | "insured_medicare"
  | "insured_medicaid"
  | "insured_dual_eligible"
  | "uninsured_self_pay"
  | "unknown";

export interface CohortAggregate {
  coverage_status: CoverageStatusAtDos;
  median_billed: number | null;
  median_allowed: number | null;
  median_patient_owes: number | null;
  oop_p10: number | null;
  oop_p90: number | null;
  observation_count: number;
  confidence: ConfidenceMeta;
}

/**
 * Phase 4 wires the `pricing_data → pricing_aggregates` aggregator (Phase 0
 * finding #3). v1 returns nulls inside aggregates and empty `references`.
 *
 * Cohort invariants per P2-11 + Q-DR-1B3-3:
 *   - `primary.coverage_status` matches the user's cohort at query time
 *   - Other-cohort observations live in `references[]`, never mixed into `primary`
 *   - `references[]` excludes the primary cohort to avoid double-display
 *   - "unknown" cohort surfaces in `references[]` only above its k-anon floor
 */
export interface PricingAggregateSummary {
  service_slug: string;
  procedure_code: string | null;
  procedure_category: string | null;

  primary: CohortAggregate;
  references: CohortAggregate[];

  medicare_benchmark: number | null;
  hospital_chargemaster_price: number | null;
  cash_self_pay_official: number | null;

  data_freshness: string | null;
  confidence: ConfidenceMeta;
}

// --- Quality (Phase 6 wires CMS Care Compare ingest; v1 returns null) -------

export interface CMSMeasure {
  measure_id: string;
  measure_name: string;
  value: number | string;
  benchmark: number | string | null;
  reporting_period: string;
}

/** Phase 6 wires CMS Care Compare. v1 returns null. */
export interface QualitySignals {
  cms_overall_rating: number | null;
  hospital_compare_measures: CMSMeasure[] | null;
}

// --- Community signals ------------------------------------------------------

export interface BillingErrorRate {
  rate: number;
  observation_count: number;
  confidence: ConfidenceMeta;
  parent_npi_rollup: boolean;
}

export interface DisputeSuccessRate {
  rate: number;
  observation_count: number;
  confidence: ConfidenceMeta;
}

export interface ReimbursementFrequency {
  rate: number;
  median_reimbursement_pct: number;
  observation_count: number;
  confidence: ConfidenceMeta;
}

export interface FacilityRatings {
  overall: number;
  bedside_manner: number | null;
  wait_time: number | null;
  billing_accuracy: number | null;
  observation_count: number;
  confidence: ConfidenceMeta;
}

export interface DepartmentRating {
  department: string;
  overall: number;
  observation_count: number;
  confidence: ConfidenceMeta;
}

export interface DepartmentRatings {
  by_department: Record<string, DepartmentRating>;
}

/**
 * Each field nullable below its k-anon threshold per K_ANON_THRESHOLDS.
 * `written_reviews_count` is always present (returns 0 if no reviews).
 */
export interface CommunitySignals {
  billing_error_rate: BillingErrorRate | null;
  dispute_success_rate: DisputeSuccessRate | null;
  reimbursement_frequency: ReimbursementFrequency | null;
  facility_ratings: FacilityRatings | null;
  department_ratings: DepartmentRatings | null;
  written_reviews_count: number;
}

// --- Charity care (Phase 6 wires; v1 returns null) --------------------------

/** Phase 6 wires `provider_charity_care_policies` table. v1 returns null. */
export interface CharityCarePolicy {
  offered: boolean;
  income_threshold_pct_fpl: number | null;
  approval_rate: number | null;
  source_url: string | null;
  last_verified_at: string | null;
  confidence: ConfidenceMeta;
}

// --- Plan-aware overlay -----------------------------------------------------

/** Returned only when query passes `user_plan_id`. Phase 5 wires. */
export interface PlanAwareOverlay {
  user_plan_id: string;
  copay_amount: number | null;
  coinsurance_pct: number | null;
  deductible_remaining: number | null;
  oop_max_remaining: number | null;
  in_network: boolean;
  plan_specific_estimate: number | null;
  confidence: ConfidenceMeta;
}

// --- Doctor ratings ---------------------------------------------------------

/** Null below n=K_ANON_THRESHOLDS.ratings. Phase 5 wires. */
export interface DoctorRatings {
  overall: number;
  bedside_manner: number | null;
  appointment_wait_days: number | null;
  in_visit_wait_minutes: number | null;
  billing_accuracy: number | null;
  observation_count: number;
  confidence: ConfidenceMeta;
}

// ----------------------------------------------------------------------------
// Layer 2: Composed query results
// ----------------------------------------------------------------------------

/**
 * Composed result for facility-typed providers (hospital / clinic / urgent_care /
 * physician_group / pharmacy / lab). For individual practitioners use Doctor.
 */
export interface Facility {
  provider: Provider;
  facility_attributes: FacilityAttributes;
  network_status: NetworkStatus;
  pricing: PricingAggregateSummary | null;
  quality: QualitySignals | null;
  community: CommunitySignals;
  charity_care: CharityCarePolicy | null;
  plan_aware: PlanAwareOverlay | null;
}

/**
 * Composed result for individual practitioners (NPI Type 1).
 * Invariant: `provider.provider_type === "individual"`.
 */
export interface Doctor {
  provider: Provider;
  facility_affiliation: Provider | null;
  ratings: DoctorRatings | null;
}

// ----------------------------------------------------------------------------
// Read-function input/output types
// ----------------------------------------------------------------------------

export type FacilitySortField =
  | "median_oop_asc"
  | "median_oop_desc"
  | "billing_error_rate_asc"
  | "rating_desc"
  | "distance_asc";

export interface FacilitySearchInput {
  location:
    | { zip: string }
    | { lat: number; lng: number; radius_miles?: number };
  service_slug?: string;
  facility_types?: ProviderType[];
  network_filter?: { user_plan_id: string };
  charity_care_only?: boolean;
  sort_by?: FacilitySortField;
  limit?: number;
  offset?: number;
}

export type EmptyStateReason =
  | "no_results"
  | "below_k_anon"
  | "phase_not_wired"
  | "data_freshness_stale";

export interface FacilitySearchResult {
  facilities: Facility[];
  total_count: number;
  query_confidence: ConfidenceMeta;
  empty_state_reason?: EmptyStateReason;
}

export interface DoctorSearchInput {
  query: string;
  zip?: string;
  specialty?: string;
  facility_id?: string;
  limit?: number;
  offset?: number;
}

export interface DoctorSearchResult {
  doctors: Doctor[];
  total_count: number;
  query_confidence: ConfidenceMeta;
  empty_state_reason?: EmptyStateReason;
}

// ----------------------------------------------------------------------------
// Read-function stubs (Phase 4 wires)
// ----------------------------------------------------------------------------

const PHASE_4_NOT_WIRED = "Phase 4 wires this; src/lib/care/interface.ts is v1 contract only.";
const PHASE_5_NOT_WIRED = "Phase 5 wires this; src/lib/care/interface.ts is v1 contract only.";
const PHASE_6_NOT_WIRED = "Phase 6 wires this; src/lib/care/interface.ts is v1 contract only.";

export async function searchFacilities(
  input: FacilitySearchInput,
): Promise<FacilitySearchResult> {
  void input;
  throw new Error(PHASE_4_NOT_WIRED);
}

export async function getFacility(input: {
  provider_id: string;
  user_plan_id?: string;
  service_slug?: string;
}): Promise<Facility | null> {
  void input;
  throw new Error(PHASE_4_NOT_WIRED);
}

export async function searchDoctors(
  input: DoctorSearchInput,
): Promise<DoctorSearchResult> {
  void input;
  throw new Error(PHASE_4_NOT_WIRED);
}

export async function getDoctor(
  input: { provider_id: string } | { npi: string },
): Promise<Doctor | null> {
  void input;
  throw new Error(PHASE_4_NOT_WIRED);
}

export async function getProviderPricing(input: {
  provider_id: string;
  service_slug: string;
  user_plan_id?: string;
  coverage_status?: CoverageStatusAtDos;
}): Promise<PricingAggregateSummary | null> {
  void input;
  throw new Error(PHASE_4_NOT_WIRED);
}

export async function getProviderQuality(input: {
  provider_id: string;
}): Promise<QualitySignals | null> {
  void input;
  throw new Error(PHASE_6_NOT_WIRED);
}

export async function getCommunitySignals(input: {
  provider_id: string;
}): Promise<CommunitySignals> {
  void input;
  throw new Error(PHASE_5_NOT_WIRED);
}

export async function getCharityCarePolicy(input: {
  provider_id: string;
  household_income?: number;
}): Promise<CharityCarePolicy | null> {
  void input;
  throw new Error(PHASE_6_NOT_WIRED);
}
