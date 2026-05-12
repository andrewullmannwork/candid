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
export function getTimeDecayBracket(parseAgeDays: number): TimeDecayBracket {
  if (parseAgeDays <= 90) return "0_90d";
  if (parseAgeDays <= 180) return "91_180d";
  if (parseAgeDays <= 365) return "181_365d";
  return "366d_plus";
}

export function getTimeDecayMultiplier(parseAgeDays: number): number {
  return TIME_DECAY_MULTIPLIER[getTimeDecayBracket(parseAgeDays)];
}

/**
 * Effective weight for a single parse event = trust × time-decay.
 */
export function effectiveWeight(tier: TrustTier, parseAgeDays: number): number {
  return TRUST_WEIGHT[tier] * getTimeDecayMultiplier(parseAgeDays);
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
