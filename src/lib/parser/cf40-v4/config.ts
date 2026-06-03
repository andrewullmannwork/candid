/**
 * CF-40 v4 — Ship Gate G6: flag-config-backed thresholds (Ing-D.1 flip-blocker).
 *
 * Every numeric threshold/weight the v4 algorithm gates on is centralized here as
 * a single `CF40V4Config` shape. `DEFAULT_CF40V4_CONFIG` is composed BY REFERENCE
 * from the per-module constant objects (the existing source of truth — no value is
 * duplicated), so `parseCF40V4Config({})` is byte-identical to today's hardcoded
 * behavior. `loadCF40V4Config(supabase)` reads the `cf40_v4_config` feature-flag
 * `config` JSONB and overlays any provided values onto the defaults — so thresholds
 * are tunable by DB UPDATE during the Ing-D.1 staged rollout with NO code deploy.
 *
 * G6 is the LAST hard blocker for the `cf40_v4_algorithm` flip (Andrew sign-off
 * S156; see [[project_ing_d_aggregation_ts_decision]]). Aggregation stays TS-side
 * (NOT a Postgres RPC) — this module config-backs the thresholds the TS evaluators
 * read; the in-database row-reduction is a separate, deferred scale-out item.
 *
 * Layering (acyclic): the leaf constant files (types / trust-weight /
 * scale-thresholds / validity-gates / doctype-expected-counts) do NOT import this
 * module — their pure functions take a sub-config param defaulting to their own
 * local constant. This module imports THOSE constants to build the default; the
 * mid-level evaluators + the two FLAG-ON orchestrators import this module.
 */

import type { createServerClient } from "@/lib/supabase/server";
import {
  SCALE_BOUNDARIES,
  TIME_DECAY_MULTIPLIER,
  TRUST_WEIGHT,
  type ScaleTier,
  type TimeDecayBracket,
  type TrustTier,
} from "./types";
import { STABILITY_THRESHOLD, TIME_DECAY_BRACKET_DAYS } from "./trust-weight";
import {
  CORROBORATION_THRESHOLDS,
  IDENTITY_PLAUSIBILITY,
  MINORITY_ROUTER,
  RAPID_CHANGE_THRESHOLDS,
  REPARSE_SAMPLING,
  SLOW_DRIFT,
  SUPERMAJORITY_SHARES,
  type CorroborationThresholds,
  type RapidChangeThresholds,
  type ReparseSamplingThresholds,
} from "./scale-thresholds";
import { VALIDITY_THRESHOLDS } from "./validity-gates";
import { DEFAULT_COVERAGE_CONFIG, type CoverageConfig } from "@/lib/parser/doctype-expected-counts";

type SupabaseClient = ReturnType<typeof createServerClient>;

/** Feature-flag key carrying the tunable threshold config (mig 143, default ON). */
export const CF40_V4_CONFIG_FLAG_KEY = "cf40_v4_config" as const;

// ── Sub-shapes that mirror the per-module constant objects ───────────────────

export interface WeightsConfig {
  /** Layer 2 trust-weight per tier (TRUST_WEIGHT). */
  trust: Record<TrustTier, number>;
  /** Layer 2 time-decay multiplier per bracket (TIME_DECAY_MULTIPLIER). */
  timeDecay: Record<TimeDecayBracket, number>;
  /** Inclusive upper day-bounds of the first three decay brackets (TIME_DECAY_BRACKET_DAYS). */
  timeDecayBracketDays: { recentMaxDays: number; midMaxDays: number; agedMaxDays: number };
  /** Layer 2 (canonical, hash) stability threshold Σ effective_weight (STABILITY_THRESHOLD). */
  stabilityThreshold: number;
}

export interface ScaleConfig {
  /** Inclusive upper upload-count bounds of the cold_start / small / medium tiers. */
  coldStartMax: number;
  smallMax: number;
  mediumMax: number;
}

export interface SupermajorityConfig {
  /** uploadCount ≤ this stays at the strictest (very-cold-start) share. */
  veryColdStartMaxUploads: number;
  veryColdStart: number;
  coldStart: number;
  small: number;
  mediumLarge: number;
}

export interface PlausibilityConfig {
  min: number;
  max: number;
}

export interface MinorityRouterConfig {
  minVerifiedUsers: number;
  minMinorityWeight: number;
}

export interface SlowDriftConfig {
  divergenceRate30dThreshold: number;
  divergentUserCount30dThreshold: number;
}

export interface ValidityConfig {
  selfCheckPassRate: number;
  ocrConfidence: number;
  classificationConfidence: number;
  fileSizeMinPlanDoc: number;
  fileSizeMinSbc: number;
  fileSizeMinEoc: number;
  fileSizeMinEducation: number;
}

export interface AdminAttestationConfig {
  /** Min admin uploads per (canonical, doc_type) for the admin-attested path. */
  minUploadsPerDocType: number;
}

export interface ForcedReparseConfig {
  /** Every Nth smart-skip on a stable hash forces a full parse (Layer 5 trigger #6). */
  everyNthSmartSkip: number;
}

// ── The full config ──────────────────────────────────────────────────────────

export interface CF40V4Config {
  scale: ScaleConfig;
  weights: WeightsConfig;
  corroboration: Record<ScaleTier, CorroborationThresholds>;
  supermajority: SupermajorityConfig;
  coverage: CoverageConfig;
  slowDrift: SlowDriftConfig;
  rapidChange: Record<ScaleTier, RapidChangeThresholds>;
  reparseSampling: Record<ScaleTier, ReparseSamplingThresholds>;
  plausibility: PlausibilityConfig;
  minorityRouter: MinorityRouterConfig;
  validity: ValidityConfig;
  adminAttestation: AdminAttestationConfig;
  forcedReparse: ForcedReparseConfig;
}

/**
 * The code defaults — composed BY REFERENCE from the per-module constants so there
 * is exactly one source of truth. `parseCF40V4Config({})` deep-equals this, which
 * deep-equals the legacy hardcoded behavior (asserted in the G6 fixture). The two
 * scalars not owned by a per-module constant object (admin min-uploads = 2; every-
 * Nth smart-skip = 5) live here, mirroring the pre-G6 inline literals.
 */
export const DEFAULT_CF40V4_CONFIG: CF40V4Config = {
  scale: { coldStartMax: SCALE_BOUNDARIES.coldStartMax, smallMax: SCALE_BOUNDARIES.smallMax, mediumMax: SCALE_BOUNDARIES.mediumMax },
  weights: {
    trust: TRUST_WEIGHT,
    timeDecay: TIME_DECAY_MULTIPLIER,
    timeDecayBracketDays: {
      recentMaxDays: TIME_DECAY_BRACKET_DAYS.recentMaxDays,
      midMaxDays: TIME_DECAY_BRACKET_DAYS.midMaxDays,
      agedMaxDays: TIME_DECAY_BRACKET_DAYS.agedMaxDays,
    },
    stabilityThreshold: STABILITY_THRESHOLD,
  },
  corroboration: CORROBORATION_THRESHOLDS,
  supermajority: {
    veryColdStartMaxUploads: SUPERMAJORITY_SHARES.veryColdStartMaxUploads,
    veryColdStart: SUPERMAJORITY_SHARES.veryColdStart,
    coldStart: SUPERMAJORITY_SHARES.coldStart,
    small: SUPERMAJORITY_SHARES.small,
    mediumLarge: SUPERMAJORITY_SHARES.mediumLarge,
  },
  coverage: DEFAULT_COVERAGE_CONFIG,
  slowDrift: {
    divergenceRate30dThreshold: SLOW_DRIFT.divergenceRate30dThreshold,
    divergentUserCount30dThreshold: SLOW_DRIFT.divergentUserCount30dThreshold,
  },
  rapidChange: RAPID_CHANGE_THRESHOLDS,
  reparseSampling: REPARSE_SAMPLING,
  plausibility: { min: IDENTITY_PLAUSIBILITY.min, max: IDENTITY_PLAUSIBILITY.max },
  minorityRouter: { minVerifiedUsers: MINORITY_ROUTER.minVerifiedUsers, minMinorityWeight: MINORITY_ROUTER.minMinorityWeight },
  validity: { ...VALIDITY_THRESHOLDS },
  adminAttestation: { minUploadsPerDocType: 2 },
  forcedReparse: { everyNthSmartSkip: 5 },
};

// ── Parse (overlay DB config onto defaults) ──────────────────────────────────

/**
 * Structure-preserving overlay: walk the default skeleton and, at each leaf, take
 * the DB value only when its type is compatible (finite number for a number leaf,
 * boolean for a boolean leaf, finite-number-or-null for a nullable-number leaf).
 * Unknown keys + type mismatches are ignored — a missing / partial / malformed
 * config can only fall BACK to a default, never weaken or corrupt the shape.
 */
function overlay<T>(def: T, raw: unknown): T {
  if (raw === undefined) return def;
  if (typeof def === "number") {
    return (typeof raw === "number" && Number.isFinite(raw) ? raw : def) as T;
  }
  if (typeof def === "boolean") {
    return (typeof raw === "boolean" ? raw : def) as T;
  }
  // Nullable-number leaf (e.g. diversity thresholds default to null): accept a
  // finite number, otherwise keep null.
  if (def === null) {
    return (typeof raw === "number" && Number.isFinite(raw) ? raw : null) as T;
  }
  if (typeof def === "object") {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return def;
    const out: Record<string, unknown> = { ...(def as Record<string, unknown>) };
    const rawObj = raw as Record<string, unknown>;
    for (const k of Object.keys(out)) {
      if (k in rawObj) out[k] = overlay(out[k], rawObj[k]);
    }
    return out as T;
  }
  return def;
}

/**
 * Build a CF40V4Config from a raw `feature_flag_rules.config` JSONB blob. A null /
 * empty / partial / malformed blob yields the code defaults (byte-identical to the
 * pre-G6 behavior). Pure — exported for fixture coverage.
 */
export function parseCF40V4Config(raw: unknown): CF40V4Config {
  if (raw === null || raw === undefined || typeof raw !== "object") return DEFAULT_CF40V4_CONFIG;
  return overlay(DEFAULT_CF40V4_CONFIG, raw);
}

/**
 * Load the tunable threshold config from the `cf40_v4_config` flag's `config`
 * JSONB. Reads the row regardless of `enabled` (config flags carry tuning, not a
 * gate — mirrors `loadStrengthConfig`). Any failure falls back to the code
 * defaults — threshold resolution is never blocked by config I/O.
 */
export async function loadCF40V4Config(supabase: SupabaseClient): Promise<CF40V4Config> {
  try {
    const { data } = await supabase
      .from("feature_flag_rules")
      .select("config")
      .eq("flag_key", CF40_V4_CONFIG_FLAG_KEY)
      .maybeSingle();
    return parseCF40V4Config(data?.config ?? null);
  } catch {
    return DEFAULT_CF40V4_CONFIG;
  }
}
