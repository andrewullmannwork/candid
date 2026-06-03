/**
 * CF-40 v4 (S73.5 D2b) — Scale-aware thresholds for Layers 3, 4, and 5.
 *
 * Source: Subplan §2.4(a) + §2.7(b) + §2.8 + LOCKed decisions §5.
 *
 * All thresholds keyed on `ScaleTier` derived from canonical's lifetime
 * upload_count. Scale tiers:
 *   cold_start: 0-100 uploads
 *   small:      101-10K
 *   medium:     10K-1M
 *   large:      1M+
 */

import type { ScaleTier } from "./types";

// ── Layer 3(a) corroboration thresholds ──────────────────────────────────────

export interface CorroborationThresholds {
  /** N — distinct phone+email-verified user count required. */
  distinctUsers: number;
  /** M — total qualifying upload count required. */
  totalUploads: number;
  /** K — distinct calendar days required (alternative to time span). */
  distinctDays: number;
  /** T — time span days required (alternative to distinct days). */
  timeSpanDays: number;
  /** S — high-volume distinct-user bypass for temporal req. */
  highVolumeBypass: number;
  /** Diversity requirements (apply at medium+ scale only). */
  ipBlocks: number | null;
  asns: number | null;
  emailDomains: number | null;
}

export const CORROBORATION_THRESHOLDS: Readonly<Record<ScaleTier, CorroborationThresholds>> = {
  cold_start: {
    distinctUsers: 3,
    totalUploads: 5,
    distinctDays: 3,
    timeSpanDays: 7,
    highVolumeBypass: 25,
    ipBlocks: null,
    asns: null,
    emailDomains: null,
  },
  small: {
    distinctUsers: 5,
    totalUploads: 10,
    distinctDays: 5,
    timeSpanDays: 14,
    highVolumeBypass: 75,
    ipBlocks: null,
    asns: null,
    emailDomains: null,
  },
  medium: {
    distinctUsers: 10,
    totalUploads: 25,
    distinctDays: 10,
    timeSpanDays: 30,
    highVolumeBypass: 200,
    ipBlocks: 3,
    asns: 3,
    emailDomains: null,
  },
  large: {
    distinctUsers: 20,
    totalUploads: 50,
    distinctDays: 20,
    timeSpanDays: 60,
    highVolumeBypass: 1000,
    ipBlocks: 3,
    asns: 5,
    emailDomains: 2,
  },
};

// ── Layer 3(b) supermajority share thresholds ───────────────────────────────

/**
 * Required supermajority share over time-decayed weights. Cold-start (≤10
 * uploads) is 1.00 (no divergence tolerated). Small/medium relax to 0.80 /
 * 0.66.
 *
 * Note: Subplan §2.4(b) has a 0-10 sub-tier at 1.00; we treat upload_count ≤ 10
 * within cold_start as 1.0, else 0.80 for cold_start range 11-100. The scale
 * tier is `cold_start` for both, so use uploadCount to disambiguate.
 */
/**
 * Supermajority share thresholds. G6-tunable via `cf40_v4_config.supermajority`;
 * the literal defaults are the pre-G6 1.00 / 0.80 / 0.66.
 */
export const SUPERMAJORITY_SHARES = {
  /** uploadCount ≤ this stays at the strictest (very-cold-start) share. */
  veryColdStartMaxUploads: 10,
  veryColdStart: 1.0,
  coldStart: 0.80,
  small: 0.66,
  mediumLarge: 0.66,
} as const;

export function supermajorityThreshold(
  uploadCount: number,
  tier: ScaleTier,
  shares: {
    veryColdStartMaxUploads: number;
    veryColdStart: number;
    coldStart: number;
    small: number;
    mediumLarge: number;
  } = SUPERMAJORITY_SHARES,
): number {
  if (uploadCount <= shares.veryColdStartMaxUploads) return shares.veryColdStart; // very-cold-start
  if (tier === "cold_start") return shares.coldStart; // 11-100
  if (tier === "small") return shares.small; // 101-10K
  // medium + large (cross-IP diversity from §2.4(a) adds defense)
  return shares.mediumLarge;
}

// ── Layer 4(b) rapid-change thresholds ───────────────────────────────────────

export interface RapidChangeThresholds {
  /** Distinct users converging on the candidate within window. */
  distinctUsersInWindow: number;
  /** Time window (days). */
  timeWindowDays: number;
  /** Diversity requirements per scale. */
  ipBlocks: number | null;
  emailDomains: number | null;
  asns: number | null;
  /** Whether admin must explicitly confirm before invalidation fires. */
  requiresAdminReview: boolean;
  /** Plausibility check: divergent value must be within [0.2x, 5x] of baseline. */
  plausibilityRangeMin: number;
  plausibilityRangeMax: number;
}

export const RAPID_CHANGE_THRESHOLDS: Readonly<Record<ScaleTier, RapidChangeThresholds>> = {
  cold_start: {
    distinctUsersInWindow: 3,
    timeWindowDays: 7,
    ipBlocks: 2,
    emailDomains: null,
    asns: null,
    requiresAdminReview: true, // 0-100: ADMIN REVIEW REQUIRED (Subplan §2.7(b))
    plausibilityRangeMin: 0.2,
    plausibilityRangeMax: 5.0,
  },
  small: {
    distinctUsersInWindow: 5,
    timeWindowDays: 14,
    ipBlocks: null,
    emailDomains: 2,
    asns: null,
    requiresAdminReview: false,
    plausibilityRangeMin: 0.2,
    plausibilityRangeMax: 5.0,
  },
  medium: {
    distinctUsersInWindow: 10,
    timeWindowDays: 14,
    ipBlocks: 3,
    emailDomains: null,
    asns: 3,
    requiresAdminReview: false,
    plausibilityRangeMin: 0.2,
    plausibilityRangeMax: 5.0,
  },
  large: {
    distinctUsersInWindow: 30,
    timeWindowDays: 14,
    ipBlocks: 5,
    emailDomains: 3,
    asns: 7,
    requiresAdminReview: false,
    plausibilityRangeMin: 0.2,
    plausibilityRangeMax: 5.0,
  },
};

// ── Layer 5 sample rates + temporal staleness ────────────────────────────────

export interface ReparseSamplingThresholds {
  /** Probability that a smart-skip-eligible upload is forced to full-parse. */
  sampleRate: number;
  /** Days since last full parse → force full parse regardless. */
  temporalStalenessDays: number;
}

export const REPARSE_SAMPLING: Readonly<Record<ScaleTier, ReparseSamplingThresholds>> = {
  cold_start: { sampleRate: 0.25, temporalStalenessDays: 90 },
  small: { sampleRate: 0.05, temporalStalenessDays: 90 },
  medium: { sampleRate: 0.02, temporalStalenessDays: 120 },
  large: { sampleRate: 0.005, temporalStalenessDays: 180 },
};

/** Layer 4(a) slow-drift detection thresholds (UNCHANGED from v3). */
export const SLOW_DRIFT = {
  divergenceRate30dThreshold: 0.3,
  divergentUserCount30dThreshold: 3,
} as const;

/**
 * Ing-D.0c-ii — plausibility band for an identity-scalar challenger relative to
 * the served baseline. A divergent value must land within [min×, max×] of the
 * baseline to be treated as a real candidate (vs OCR/Haiku garbage like $0.01 or
 * $100k on a $2k deductible). Shared by verification-mode OPEN (§2.7c) and
 * rapid-change (§2.7b — RAPID_CHANGE_THRESHOLDS carries the same band per-tier;
 * this is the scale-independent default the verification-mode path uses).
 */
export const IDENTITY_PLAUSIBILITY = { min: 0.2, max: 5.0 } as const;

/**
 * Ing-D.0d — Layer-3(b) minority-candidate router gates. Tunable (Ship Gate G6;
 * promote to feature-flag config when the MVP knobs need runtime adjustment).
 *   - minVerifiedUsers: a vote split only matters once ≥N distinct phone+email-
 *     verified users have uploaded (no routing on a single-uploader canonical or
 *     the natural single-user state). Pattern 1 #15 — the same verified denominator
 *     the supermajority + slow-drift use.
 *   - minMinorityWeight: surface a dissenting tuple once its summed effective weight
 *     exceeds this floor. Default 0 = surface EVERY minority (recall over precision —
 *     the admin queue is the precision gate, per feedback_candid_recall_over_precision;
 *     implausible values are STAMPED, not dropped). Raise if cold-start admin load is
 *     too high.
 */
export const MINORITY_ROUTER = {
  minVerifiedUsers: 2,
  minMinorityWeight: 0,
} as const;
