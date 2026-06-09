/**
 * ID-Block — Ship Gate G6: flag-config-backed gate thresholds.
 *
 * Every tunable the corroboration source-independence GATE reads — the
 * cluster-legitimacy signal weights + normalization caps, the cluster-shape
 * windows, the legitimacy threshold + Hamming near-dup cutoff, the quarantine mode,
 * and Slack alerting — is centralized here as a single `IdBlockConfig`.
 * `DEFAULT_ID_BLOCK_CONFIG` is the code source of truth; `loadIdBlockConfig`
 * overlays the `id_block_corroboration` flag's `config` JSONB so thresholds are
 * tunable by DB UPDATE with NO code deploy — mirrors `loadCF40V4Config`.
 *
 * What is NOT here: the simhash CONSTRUCTION params (shingle size / hash /
 * normalization). Those are PINNED in content-fingerprint.ts (ALGO_VERSION) — a
 * change there invalidates stored fingerprints, so it is a re-backfill event, not a
 * runtime tune. This split keeps the Hamming cutoff tunable while guaranteeing
 * stored fingerprints stay comparable.
 *
 * The flag is the MASTER GATE:
 *   enabled = false / absent → gate never runs → BYTE-IDENTICAL promotion (default).
 *   enabled = true           → gate runs; config.gate.mode shadow | active.
 * The pure scorer (cluster-legitimacy.ts) takes an IdBlockConfig param defaulting to
 * DEFAULT_ID_BLOCK_CONFIG, so it is fully testable without a DB.
 *
 * SoT: plans/id-block-corroboration-source-independence.md §5 + §9.5.
 */

import type { createServerClient } from "@/lib/supabase/server";

type SupabaseClient = ReturnType<typeof createServerClient>;

/** Feature-flag key gating the ID-Block corroboration quarantine (default OFF). */
export const ID_BLOCK_FLAG_KEY = "id_block_corroboration" as const;

export type QuarantineMode = "shadow" | "active";

export interface LegitimacyWeights {
  /** costly artifacts: claims-with-EOB / subscription / card. */
  high: number;
  /** a "life" behind the account: age / signup-latency / activity breadth. */
  medium: number;
  /** profile completeness (cheap). */
  low: number;
}

export interface LegitimacyNormCaps {
  /** account age (days) at which the age sub-signal saturates to 1. */
  accountAgeDaysCap: number;
  /** signup→upload latency (days) at which that sub-signal saturates to 1. */
  signupLatencyDaysCap: number;
  /** distinct-action count at which activity breadth saturates to 1. */
  activityBreadthCap: number;
}

export interface ClusterShapeConfig {
  /** per-user score below this counts as "thin"; uniformlyThin = ALL members thin. */
  thinScore: number;
  /** corroborating uploads all within this window (hours) ⇒ temporalBurst. */
  burstWindowHours: number;
  /** member accounts all created within this window (hours) ⇒ signupCorrelated. */
  signupCorrelationWindowHours: number;
}

export interface IdBlockGateConfig {
  /** cluster legitimacy (median) below which a TRIGGERED cluster is flagged. */
  clusterLegitimacyThreshold: number;
  /** Hamming distance (of 64 bits) at/below which two fingerprints are "same document". */
  hammingNearDupThreshold: number;
  /** fraction of fingerprinted members that must be near-dup for sameContent. */
  sameContentMajority: number;
  /** shadow = log/Slack/panel, hold nothing; active = quarantine the contribution. */
  mode: QuarantineMode;
}

export interface ReEvalConfig {
  /**
   * Per-row re-evaluation cadence (days). After the daily PR3c cron re-checks a
   * still-held promotion, it re-stamps next_eval_at = now + cadenceDays, so this is
   * how many daily sweeps to skip before re-checking the same row. 1 = every night
   * (most responsive — a thin-but-real cluster auto-releases ~1 day after it crosses
   * the legitimacy bar). Tuned in the §5 editor. Does NOT cap retries — a held row is
   * re-checked indefinitely until it clears or an admin acts (delayed-not-denied).
   */
  cadenceDays: number;
  /**
   * Safety throughput bound: max held rows re-checked per nightly sweep (oldest-due
   * first). Overflow is logged and rides the next sweep — never silently dropped, and
   * never a limit on whether a promotion eventually clears. A backstop, not policy.
   */
  maxRowsPerSweep: number;
}

export interface IdBlockConfig {
  weights: LegitimacyWeights;
  normCaps: LegitimacyNormCaps;
  shape: ClusterShapeConfig;
  gate: IdBlockGateConfig;
  /** PR3c daily re-eval cron cadence (delayed-not-denied). */
  reEval: ReEvalConfig;
  slack: {
    /** fire an ID-Block Slack alert on each would-flag (per-cluster, deduped). */
    enabled: boolean;
  };
}

/**
 * Code defaults. `parseIdBlockConfig({})` deep-equals this. Conservative starting
 * points — the operating threshold is tuned on the real would-flag rate during the
 * shadow-measure phase (§5) before anything is held.
 */
export const DEFAULT_ID_BLOCK_CONFIG: IdBlockConfig = {
  weights: { high: 1.0, medium: 0.5, low: 0.2 },
  normCaps: {
    accountAgeDaysCap: 180,
    signupLatencyDaysCap: 30,
    activityBreadthCap: 8,
  },
  shape: {
    thinScore: 0.35,
    burstWindowHours: 72,
    signupCorrelationWindowHours: 48,
  },
  gate: {
    clusterLegitimacyThreshold: 0.35,
    hammingNearDupThreshold: 3,
    sameContentMajority: 0.5,
    mode: "shadow",
  },
  reEval: {
    cadenceDays: 1,
    maxRowsPerSweep: 100,
  },
  slack: { enabled: true },
};

/**
 * Structure-preserving overlay (mirrors cf40-v4/config.ts): walk the default
 * skeleton; at each leaf take the DB value only when type-compatible (finite number
 * for a number leaf, boolean for a boolean leaf, a known QuarantineMode string for
 * the mode leaf). Unknown keys + type mismatches fall back to the default — a
 * partial / malformed config can only weaken toward defaults, never corrupt shape.
 */
function overlay<T>(def: T, raw: unknown): T {
  if (raw === undefined) return def;
  if (typeof def === "number") {
    return (typeof raw === "number" && Number.isFinite(raw) ? raw : def) as T;
  }
  if (typeof def === "boolean") {
    return (typeof raw === "boolean" ? raw : def) as T;
  }
  if (typeof def === "string") {
    // The only string leaf is the mode enum; accept only the known values.
    return (raw === "shadow" || raw === "active" ? raw : def) as T;
  }
  if (typeof def === "object" && def !== null) {
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

/** Build an IdBlockConfig from a raw `feature_flag_rules.config` JSONB blob. Pure. */
export function parseIdBlockConfig(raw: unknown): IdBlockConfig {
  if (raw === null || raw === undefined || typeof raw !== "object") return DEFAULT_ID_BLOCK_CONFIG;
  return overlay(DEFAULT_ID_BLOCK_CONFIG, raw);
}

/**
 * Load the tunable gate config from the `id_block_corroboration` flag's `config`
 * JSONB. Reads config regardless of `enabled` (the enabled bit is the gate; config
 * carries tuning). Any failure falls back to code defaults — threshold resolution is
 * never blocked by config I/O. Mirrors `loadCF40V4Config`.
 */
export async function loadIdBlockConfig(supabase: SupabaseClient): Promise<IdBlockConfig> {
  try {
    const { data } = await supabase
      .from("feature_flag_rules")
      .select("config")
      .eq("flag_key", ID_BLOCK_FLAG_KEY)
      .maybeSingle();
    return parseIdBlockConfig(data?.config ?? null);
  } catch {
    return DEFAULT_ID_BLOCK_CONFIG;
  }
}
