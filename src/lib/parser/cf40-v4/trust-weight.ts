/**
 * CF-40 v4 (S73.5 D2b) — Layer 2 trust-weight + time-decay helpers.
 *
 * effective_weight = trust_weight × time_decay_multiplier
 *
 * Stability per (canonical_plan_id, file_hash) reached when
 *   Σ effective_weight ≥ 3.0 (per Subplan §2.3 LOCK)
 * AND match conditions hold (plan-identity exact match, newServicesFound=0,
 * different uploader_user_id than previous-counted parse).
 *
 * Single-factor verified users (phone-only OR email-only) contribute to
 * Layer 2 stability counter at reduced weights — but DO NOT count toward
 * Layer 3 distinct-user count (Pattern 1 #15 preserved).
 */

import {
  type TimeDecayBracket,
  type TrustTier,
  TIME_DECAY_MULTIPLIER,
  TRUST_WEIGHT,
} from "./types";

export const STABILITY_THRESHOLD = 3.0;

/**
 * Inclusive upper day-bounds of the first three time-decay brackets (the 4th is
 * "everything older"). G6-tunable via `cf40_v4_config.weights.timeDecayBracketDays`;
 * literal defaults are the pre-G6 90 / 180 / 365.
 */
export const TIME_DECAY_BRACKET_DAYS = {
  recentMaxDays: 90,
  midMaxDays: 180,
  agedMaxDays: 365,
} as const;

/**
 * The Layer-2 weighting inputs `effectiveWeight` reads — a structural subset of
 * `CF40V4Config.weights`, so an orchestrator can pass `cfg.weights` directly while
 * unit tests / non-v4 callers omit it and get the constant defaults.
 */
export interface WeightInputs {
  trust: Record<TrustTier, number>;
  timeDecay: Record<TimeDecayBracket, number>;
  timeDecayBracketDays: { recentMaxDays: number; midMaxDays: number; agedMaxDays: number };
}

const DEFAULT_WEIGHT_INPUTS: WeightInputs = {
  trust: TRUST_WEIGHT,
  timeDecay: TIME_DECAY_MULTIPLIER,
  timeDecayBracketDays: TIME_DECAY_BRACKET_DAYS,
};

/**
 * Resolve trust tier from per-user signals. Admin overrides everything.
 */
export function resolveTrustTier(input: {
  isAdmin: boolean;
  phoneVerified: boolean;
  emailVerified: boolean;
}): TrustTier {
  if (input.isAdmin) return "admin";
  if (input.phoneVerified && input.emailVerified) return "phone_email_verified";
  if (input.phoneVerified) return "phone_only_verified";
  if (input.emailVerified) return "email_only_verified";
  return "unverified";
}

/**
 * Compute the time-decay bracket from parse age in days.
 *   0 - 90 days:    1.0
 *   91 - 180 days:  0.5
 *   181 - 365 days: 0.2
 *   366+ days:      0.0
 */
export function getTimeDecayBracket(
  parseAgeDays: number,
  bracketDays: { recentMaxDays: number; midMaxDays: number; agedMaxDays: number } = TIME_DECAY_BRACKET_DAYS,
): TimeDecayBracket {
  if (parseAgeDays <= bracketDays.recentMaxDays) return "0_90d";
  if (parseAgeDays <= bracketDays.midMaxDays) return "91_180d";
  if (parseAgeDays <= bracketDays.agedMaxDays) return "181_365d";
  return "366d_plus";
}

export function getTimeDecayMultiplier(
  parseAgeDays: number,
  weights: WeightInputs = DEFAULT_WEIGHT_INPUTS,
): number {
  return weights.timeDecay[getTimeDecayBracket(parseAgeDays, weights.timeDecayBracketDays)];
}

/**
 * Effective weight for a single parse event = trust × time-decay.
 */
export function effectiveWeight(
  tier: TrustTier,
  parseAgeDays: number,
  weights: WeightInputs = DEFAULT_WEIGHT_INPUTS,
): number {
  return weights.trust[tier] * getTimeDecayMultiplier(parseAgeDays, weights);
}

/**
 * Sum effective weights over a list of parse events with their ages.
 * Used to determine Layer 2 stability when Σ ≥ 3.0.
 */
export function sumEffectiveWeights(
  parses: ReadonlyArray<{ tier: TrustTier; parseAgeDays: number }>,
): number {
  return parses.reduce((sum, p) => sum + effectiveWeight(p.tier, p.parseAgeDays), 0);
}

/**
 * Days between parse event and now (rounded down). Use UTC math.
 */
export function parseAgeDays(parsedAt: Date | string, now: Date = new Date()): number {
  const ts = parsedAt instanceof Date ? parsedAt : new Date(parsedAt);
  if (Number.isNaN(ts.getTime())) return Number.POSITIVE_INFINITY;
  const ms = now.getTime() - ts.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}
