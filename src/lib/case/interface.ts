/**
 * Candid Case — interface contract (v1).
 *
 * Type signatures + read-function stubs for the Case service surface.
 * Implementations land in Phase 4 (existing tables) + Phase 4.5 (Partner Portal Foundation;
 * NEW lawyer_directory + firm_directory tables); v1 stubs throw at runtime.
 *
 * Design Review: plans/findings/design_review_1B.4_case_interface.md (vault).
 * Inputs: case_ux_brief, care_case_forward_compat_audit §3 + §7, Candid_Schema_Reference.
 *
 * Three layers:
 *   1. Firm + Lawyer       — base entities, 1:1 with firm_directory + lawyer_directory
 *   2. ListingTile / Listing / EngagementSummary — composed query results
 *   3. Sub-types           — one per concern
 *
 * Forward-compat rules inherited from src/lib/care/interface.ts (Q-DR-1B3 conventions):
 *   - Nullable struct fields, not optional
 *   - Sub-types extend by additive fields only
 *   - Empty-state reasons are an enum (exhaustive switch)
 *   - New input params are optional
 *   - Phase-gated comments mark unwired sub-types
 *
 * Cross-cutting types (ConfidenceMeta, SourceProvenance) duplicated from
 * src/lib/care/interface.ts for v1 — refactor to src/lib/shared/types.ts after
 * 1B.3 + 1B.4 land and we see the actual shared surface.
 */

// ----------------------------------------------------------------------------
// Constants — Case-specific k-anon thresholds
// ----------------------------------------------------------------------------

/**
 * k-anonymity thresholds gating defamation- and selection-bias-exposed surfaces.
 *
 * Changes require legal review — these gate community-aggregate signals about named
 * lawyers and the marketplace. Eligibility filtering is intentionally NOT here:
 * showing 1 eligible lawyer when 1 exists is per-lawyer info, not aggregation.
 *
 * Values are Case-specific (not inherited from src/lib/care/interface.ts) per
 * Q-DR-1B4 user pushback: each surface has its own defamation profile.
 */
export const K_ANON_THRESHOLDS = {
  lawyer_ratings: 5,
  rating_breakdown: 5,
  cases_handled_count: 5,
  median_recovery: 10,
  response_time: 5,
  small_claims_timeline: 5,
  marketplace_total: 25,
} as const;

// ----------------------------------------------------------------------------
// Cross-cutting types (duplicated from src/lib/care/interface.ts for v1)
// ----------------------------------------------------------------------------

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

// ----------------------------------------------------------------------------
// Layer 1: Base entities
// ----------------------------------------------------------------------------

// --- Firm ------------------------------------------------------------------

export type FirmListingStatus =
  | "active"
  | "paused"
  | "suspended"
  | "removed";

/**
 * 1:1 with `firm_directory` (Phase 4.5 NEW table per audit §4.1).
 * Solo practitioners get a Firm-of-1 with `solo: true`. Uniform model.
 *
 * Note: malpractice insurance carrier is intentionally NOT collected per
 * Q-DR-1G1-3 lock (Session 42). Candid is a marketplace, not a vetting service.
 * See Candid_Onboarding_Patterns + Candid_ToS §7.10/§7.11.
 */
export interface Firm {
  id: string;
  name: string;
  display_name: string;
  primary_state: string;
  website_url: string | null;
  phone: string | null;

  listing_status: FirmListingStatus;
  accepts_referrals: boolean;
  founded_year: number | null;
  solo: boolean;

  is_active: boolean;
  last_verified_at: string | null;
}

// --- Lawyer ----------------------------------------------------------------

export type BarStatus =
  | "good_standing"
  | "discipline_active"
  | "suspended"
  | "voluntarily_inactive"
  | "unverified";

export type LawyerListingStatus =
  | "active"
  | "paused"
  | "suspended"
  | "stale_verification"
  | "complaint_review"
  | "removed";

/**
 * 1:1 with `lawyer_directory` (Phase 4.5 NEW table per audit §4.1; Pattern 1 instance).
 */
export interface Lawyer {
  id: string;
  firm_id: string | null;

  display_name: string;
  bar_number: string | null;
  primary_state: string;

  years_in_practice: number | null;
  years_specializing: number | null;
  bio: string | null;
  profile_photo_url: string | null;

  hourly_rate: number | null;
  hourly_rate_low: number | null;
  hourly_rate_high: number | null;
  retainer_amount: number | null;
  contingency_available: boolean | null;

  free_consultation: boolean | null;
  consultation_minutes: number | null;

  accepting_new_clients: boolean | null;

  bar_status: BarStatus;

  listing_status: LawyerListingStatus;
  listing_paused_until: string | null;
  is_active: boolean;
  state_bar_last_verified_at: string | null;
}

// ----------------------------------------------------------------------------
// Layer 3: Domain sub-types (defined before Layer 2 composed types use them)
// ----------------------------------------------------------------------------

// --- State bar admissions --------------------------------------------------

export interface DisciplinaryAction {
  date: string;
  type: string;
  description: string;
  source_url: string | null;
}

export interface StateBarAdmission {
  state: string;
  bar_number: string;
  admission_date: string;
  status: BarStatus;
  good_standing_verified_at: string | null;
  discipline_history: DisciplinaryAction[];
}

// --- Lawyer specialty + office + accessibility ----------------------------

export interface LawyerSpecialty {
  specialty_slug: string;
  display_name: string;
  self_attested: boolean;
  verified: boolean;
}

export interface LawyerOffice {
  city: string;
  state: string;
  zip: string;
  address: string | null;
  is_primary: boolean;
  remote_available: boolean;
}

export interface AccessibilityAttributes {
  wheelchair_accessible: boolean | null;
  asl_available: boolean | null;
  notes: string | null;
}

// --- Lawyer ratings + reviews ----------------------------------------------

/** Null below n=K_ANON_THRESHOLDS.lawyer_ratings. Phase 4.5 wires. */
export interface LawyerRatings {
  overall: number;
  responsiveness: number | null;
  clarity: number | null;
  expertise: number | null;
  honesty: number | null;
  observation_count: number;
  confidence: ConfidenceMeta;
}

/** Subject to right-of-response window per Q6 locked (7d for lawyer reviews). */
export interface LawyerWrittenReview {
  id: string;
  rating: number;
  body: string;
  created_at: string;
  verified_consultation: boolean;
  lawyer_response: string | null;
  lawyer_responded_at: string | null;
}

// --- Match signal ----------------------------------------------------------

export interface MatchFactor {
  factor: "case_type" | "jurisdiction" | "insurer_history" | "specialty_overlap";
  score: number;
  explanation: string;
}

/**
 * v1 default = `general` (filter-only) per Q2 Path (i) locked.
 * Ranked-sort flag-gated per state via `case_ranked_sort_enabled` after Phase 1H legal map.
 */
export interface MatchSignal {
  match_quality: "strong" | "partial" | "general";
  match_factors: MatchFactor[];
  algorithm_version: string;
  explainer_url: string | null;
}

// --- Dispute outcome -------------------------------------------------------

export type DisputeOutcomeType =
  | "pending"
  | "refund_received"
  | "partial_refund"
  | "denied"
  | "outcome_unknown";

export type RefundMethod =
  | "insurer_paid_back"
  | "provider_waived"
  | "both"
  | "unspecified";

export type DenialReason =
  | "procedural"
  | "substantive"
  | "no_response"
  | "other";

/** Already supported by existing `dispute_outcomes` table per audit §7. */
export interface DisputeOutcome {
  dispute_id: string;
  outcome_status: DisputeOutcomeType;
  outcome_amount: number | null;
  resolved_at: string | null;
  next_prompt_at: string | null;
  refund_method: RefundMethod | null;
  denial_reason: DenialReason | null;
}

// --- Case file -------------------------------------------------------------

export type CaseFileDocType =
  | "original_bill"
  | "eob"
  | "plan_benefit_evidence"
  | "audit_findings"
  | "dispute_letter"
  | "denial_response"
  | "community_pricing_evidence"
  | "timeline";

export interface CaseFileContent {
  doc_type: CaseFileDocType;
  source_id: string;
  confidence: ConfidenceMeta;
}

export interface CaseFileMetadata {
  dispute_id: string;
  available: boolean;
  contents: CaseFileContent[];
  last_generated_at: string | null;
  download_count: number;
  denial_letter_uploaded: boolean;
}

// --- Small claims ----------------------------------------------------------

export interface SmallClaimsForm {
  form_name: string;
  form_url: string;
  filing_instructions: string;
}

/**
 * Already supported by `small_claims_courts` per audit §7. Backfill F.9 ongoing.
 * "Not yet catalogued" encoded as `available: false` (function never returns null).
 */
export interface SmallClaimsPackage {
  available: boolean;
  state: string;
  county: string | null;
  court_name: string | null;
  filing_fee: { min: number; max: number } | null;
  small_claims_threshold: number | null;
  required_forms: SmallClaimsForm[];
  estimated_timeline_months: { low: number; high: number } | null;
  forms_url: string | null;
  last_verified_at: string | null;
}

// --- Marketplace metrics ---------------------------------------------------

/**
 * Aggregate; k-anon n>=K_ANON_THRESHOLDS.marketplace_total (25).
 * "No data yet" encoded as null fields within the struct (function never returns null).
 */
export interface MarketplaceMetrics {
  total_recovered: number | null;
  total_engagements: number | null;
  median_time_to_engagement_days: number | null;
  confidence: ConfidenceMeta;
}

// --- Engagement summary ----------------------------------------------------

export type EngagementStatus =
  | "consultation_scheduled"
  | "retained"
  | "case_filed"
  | "settled"
  | "closed";

// ----------------------------------------------------------------------------
// Layer 2: Composed query results
// ----------------------------------------------------------------------------

/**
 * Search-result projection — minimum data for a marketplace card (Brief Journey 3, 6).
 * Returned by `searchListings`.
 */
export interface ListingTile {
  lawyer: Lawyer;
  firm: Firm | null;
  bar_admissions: StateBarAdmission[];
  specialties: LawyerSpecialty[];
  match_signal: MatchSignal | null;
  ratings: LawyerRatings | null;
  cases_handled_count: number | null;
  response_time_hours: number | null;
}

/**
 * Full profile — extends Tile with deep-fetch fields (Brief Journey 3 click-through).
 * Returned by `getListing`. Per Q-DR-1B4-2 (c) hybrid: `extends ListingTile` enforces no drift.
 */
export interface Listing extends ListingTile {
  offices: LawyerOffice[];
  languages: string[];
  accessibility: AccessibilityAttributes | null;
  recent_reviews: LawyerWrittenReview[];
  median_recovery: number | null;
}

/**
 * Per-dispute lawyer-engagement state on the bill card (Brief Journey 4).
 * Phase 4.5 wires (`lawyer_engagements` + `lawyer_engagement_outcomes`).
 */
export interface EngagementSummary {
  engagement_id: string;
  dispute_id: string;
  lawyer: Lawyer;
  firm: Firm | null;

  status: EngagementStatus;
  engaged_at: string;
  closed_at: string | null;

  lawyer_quoted_outcome_estimate: string | null;
  final_outcome_amount: number | null;
  final_outcome_type: DisputeOutcomeType | null;
  total_fees_paid: number | null;
  net_recovery: number | null;
}

// ----------------------------------------------------------------------------
// Read-function input/output types
// ----------------------------------------------------------------------------

export type ListingSortField =
  | "match_quality_desc"
  | "rating_desc"
  | "hourly_rate_asc"
  | "recently_active";

export interface ListingSearchInput {
  user_state: string;
  case_type?: string;
  insurer_id?: string;
  bill_amount?: number;
  denial_reason?: DenialReason;

  free_consultation_only?: boolean;
  contingency_available?: boolean;
  max_hourly_rate?: number;
  language?: string;
  min_rating?: number;
  remote_ok?: boolean;
  sort_by?: ListingSortField;
  limit?: number;
  offset?: number;
}

export type EmptyStateReason =
  | "no_results"
  | "below_k_anon"
  | "phase_not_wired"
  | "no_lawyers_in_state"
  | "marketplace_not_launched_in_state";

export interface ListingSearchResult {
  listings: ListingTile[];
  total_count: number;
  query_confidence: ConfidenceMeta;
  empty_state_reason?: EmptyStateReason;
}

// ----------------------------------------------------------------------------
// Read-function stubs (Phase 4 + 4.5 wires)
// ----------------------------------------------------------------------------

const PHASE_4_NOT_WIRED = "Phase 4 wires this; src/lib/case/interface.ts is v1 contract only.";
const PHASE_4_5_NOT_WIRED = "Phase 4.5 wires this; src/lib/case/interface.ts is v1 contract only.";

export async function searchListings(
  input: ListingSearchInput,
): Promise<ListingSearchResult> {
  void input;
  throw new Error(PHASE_4_5_NOT_WIRED);
}

export async function getListing(input: {
  lawyer_id: string;
  user_case_context?: {
    case_type?: string;
    insurer_id?: string;
  };
}): Promise<Listing | null> {
  void input;
  throw new Error(PHASE_4_5_NOT_WIRED);
}

export async function getDisputeOutcome(input: {
  dispute_id: string;
}): Promise<DisputeOutcome | null> {
  void input;
  throw new Error(PHASE_4_NOT_WIRED);
}

export async function getCaseFileMetadata(input: {
  dispute_id: string;
}): Promise<CaseFileMetadata | null> {
  void input;
  throw new Error(PHASE_4_NOT_WIRED);
}

export async function getEngagementSummary(input: {
  engagement_id: string;
}): Promise<EngagementSummary | null> {
  void input;
  throw new Error(PHASE_4_5_NOT_WIRED);
}

export async function getSmallClaimsPackage(input: {
  state: string;
  county?: string;
}): Promise<SmallClaimsPackage> {
  void input;
  throw new Error(PHASE_4_NOT_WIRED);
}

export async function getMarketplaceMetrics(input: {
  state?: string;
}): Promise<MarketplaceMetrics> {
  void input;
  throw new Error(PHASE_4_5_NOT_WIRED);
}
