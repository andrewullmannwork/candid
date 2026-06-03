/**
 * CF-40 v4 (S73.5 D2b) — Shared types for the 5-layer smart-skip + promotion
 * algorithm. See [[plans/s73.5_cf40_refine]] + [[Candid_Data_Patterns]] Pattern
 * 1 #16.
 */

import type { PlanDocType } from "@/lib/parser/doctype-expected-counts";

// ── Trust tier (Layer 2 trust-weight lookup) ─────────────────────────────────

export type TrustTier =
  | "admin"
  | "phone_email_verified"
  | "phone_only_verified"
  | "email_only_verified"
  | "unverified";

export const TRUST_WEIGHT: Readonly<Record<TrustTier, number>> = {
  admin: 3.0,
  phone_email_verified: 1.0,
  phone_only_verified: 0.6,
  email_only_verified: 0.5,
  unverified: 0.0,
};

// ── Time-decay bracket (Layer 2 time decay) ──────────────────────────────────

export type TimeDecayBracket = "0_90d" | "91_180d" | "181_365d" | "366d_plus";

export const TIME_DECAY_MULTIPLIER: Readonly<Record<TimeDecayBracket, number>> = {
  "0_90d": 1.0,
  "91_180d": 0.5,
  "181_365d": 0.2,
  "366d_plus": 0.0,
};

// ── Scale tier (Layer 3 / Layer 4 / Layer 5 thresholds drive off canonical scale) ─

export type ScaleTier = "cold_start" | "small" | "medium" | "large";

/**
 * Inclusive upper upload-count bounds of the cold_start / small / medium tiers.
 * G6-tunable via `cf40_v4_config.scale`; the literal defaults are the pre-G6
 * hardcoded boundaries.
 */
export const SCALE_BOUNDARIES = {
  coldStartMax: 100,
  smallMax: 10_000,
  mediumMax: 1_000_000,
} as const;

/**
 * Scale tier from canonical's lifetime upload_count.
 *   0-100     → cold_start
 *   101-10K   → small
 *   10K-1M    → medium
 *   1M+       → large
 */
export function getScaleTier(
  uploadCount: number,
  b: { coldStartMax: number; smallMax: number; mediumMax: number } = SCALE_BOUNDARIES,
): ScaleTier {
  if (uploadCount <= b.coldStartMax) return "cold_start";
  if (uploadCount <= b.smallMax) return "small";
  if (uploadCount <= b.mediumMax) return "medium";
  return "large";
}

// ── Promotion event type (canonical_doctype_promotion_state.promotion_event_type) ─

export type PromotionEventType = "pattern1_3_organic" | "admin_attested";

// ── Layer 1 — Validity gate input ────────────────────────────────────────────

export interface ValidityGateInput {
  // Doc-quality signals are nullable: a parse path that does not PRODUCE the
  // signal passes null, and the corresponding gate is treated as INAPPLICABLE
  // (you cannot reject a parse on a measurement that was never taken). The
  // always-on structural gates (validity window, file size, auth, banned,
  // re-baseline) plus Layer 3 coverage/corroboration carry the quality floor.
  //   selfCheckPassRate: null when no Pattern P-8 verifier ran (e.g. regex /
  //     plan_document path emits no per-field source_excerpt_verified).
  //   ocrConfidence: null when no OCR step ran (native-text/pdftotext path has
  //     no OCR error mode).
  selfCheckPassRate: number | null; // 0..1, or null = gate inapplicable
  ocrConfidence: number | null; // 0..1, or null = gate inapplicable
  classificationConfidence: number | null; // 0..1, or null = inapplicable (e.g. admin upload w/o classifier confidence)
  uploadedAt: Date | string;
  documentPlanYear: number | null;
  fileSizeBytes: number;
  docType: PlanDocType;
  uploaderTier: TrustTier;
  isAdmin: boolean;
  isBanned: boolean;
  canonicalReBaselineRequired: boolean;
}

export type ValidityGateFailure =
  | "self_check_pass_rate_below_threshold"
  | "ocr_confidence_below_threshold"
  | "classification_confidence_below_threshold"
  | "outside_validity_window"
  | "file_size_below_minimum"
  | "uploader_unauthenticated"
  | "uploader_banned"
  | "canonical_re_baseline_required";

export interface ValidityGateResult {
  pass: boolean;
  failureReasons: ValidityGateFailure[];
  /** TRUE when fall-back-to-absolute-age applied because plan_year was unextractable. */
  fellBackToAbsoluteAge: boolean;
}

// ── Layer 3 promotion criteria — three independent dimensions ────────────────

export interface CorroborationCriterion {
  distinctPhoneEmailUsers: number;
  totalQualifyingUploads: number;
  distinctCalendarDays: number;
  timeSpanDays: number;
  highVolumeDistinctUsers: number;
  /** IP-block diversity count (cross-IP /16). Required at medium+ scale. */
  ipBlockDiversity?: number;
  /** ASN diversity count. Required at medium+ scale (10K-1M+). */
  asnDiversity?: number;
  /** Email-domain diversity count. Required at large scale (1M+). */
  emailDomainDiversity?: number;
}

export interface SupermajorityCriterion {
  baselineWeight: number;
  totalWeight: number;
}

export interface CoverageCriterion {
  verifiedScalarCount: number;
  verifiedServiceCount: number;
  observedServiceCounts: readonly number[];
}

export interface PromotionEvalResult {
  promoted: boolean;
  failureReasons: Array<
    | "corroboration_distinct_users_below_threshold"
    | "corroboration_total_uploads_below_threshold"
    | "corroboration_temporal_distribution_below_threshold"
    | "corroboration_diversity_below_threshold"
    | "supermajority_share_below_threshold"
    | "coverage_score_below_threshold"
  >;
  /** Per-criterion observed values for diagnostics + admin UI. */
  observed: {
    distinctUsers: number;
    totalUploads: number;
    majorityShare: number;
    coverageScore: number;
  };
}

// ── Layer 4 — Invalidation events ────────────────────────────────────────────

export type InvalidationEventType =
  | "slow_drift_invalidation"
  | "rapid_change_invalidation"
  | "rapid_change_pending_admin_review"
  | "admin_manual_invalidation"
  | "verification_mode_triggered"
  | "verification_mode_resolved_noise"
  | "verification_mode_resolved_drift";

// ── Layer 5 — Forced re-parse decision ───────────────────────────────────────

export type ForcedReparseReason =
  | "admin_upload"
  | "statistical_drift_sample"
  | "temporal_staleness"
  | "admin_attestation_validation"
  | "verification_mode"
  | "every_5th_smart_skip"
  | "first_time_hash" // not really forced; preserved for diagnostic clarity
  | null;

export interface ForcedReparseDecision {
  forceFullParse: boolean;
  reason: ForcedReparseReason;
}

export interface ForcedReparseInput {
  isAdmin: boolean;
  /** Canonical's scale tier (cold_start | small | medium | large). */
  scaleTier: ScaleTier;
  /** Smart-skip-count for this (canonical, hash) tuple. Used for every-5th gate. */
  smartSkipCount: number;
  /** Last full-parse timestamp on this (canonical, hash) — null if never. */
  lastFullParseAt: Date | string | null;
  /** Canonical-wide verification mode flag. */
  divergencePendingVerification: boolean;
  /** True if canonical was admin-attested for this doc-type AND no organic full parses since. */
  adminAttestedNeedsValidation: boolean;
  /** Sample roll source: defaults to Math.random; injectable for tests. */
  randomFn?: () => number;
  /** Now timestamp — injectable for tests. */
  now?: Date;
}

// ── Smart-skip eligibility outcome ───────────────────────────────────────────

export interface SmartSkipEligibility {
  eligible: boolean;
  // Where the decision was made — useful for telemetry & admin UI.
  decisionLayer: "layer1" | "layer2" | "layer3" | "layer4" | "layer5" | "all_pass";
  failureReason: string | null;
  /**
   * Ing-D.0c-ii — the structured Layer-5 forced-reparse reason when the
   * extraction proceeded BECAUSE Layer 5 forced a full parse of an
   * otherwise-skip-eligible (stable + promoted + valid) canonical. NULL on every
   * other outcome (eligible skip, or an extract blocked at Layer 1/2/3 — i.e. the
   * canonical was never settled, so the parse is not a "re-parse"). Plumbed
   * through DedupResult → documents.cf40_forced_reparse_reason → recordParseEventV4
   * to drive verification-mode open/resolve.
   */
  forcedReparseReason: ForcedReparseReason | null;
}
