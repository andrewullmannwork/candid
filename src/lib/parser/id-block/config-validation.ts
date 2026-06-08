/**
 * ID-Block PR3b-2 — strict validator for the admin §5 config editor (Ship Gate G4/G6).
 *
 * `loadIdBlockConfig` / `parseIdBlockConfig` (config.ts) are structure-preserving and
 * SILENTLY fall back to defaults on any bad leaf — correct for the read path (a
 * malformed stored config can only weaken toward defaults, never corrupt the gate).
 * But for the admin EDITOR that is the wrong behavior: an admin who fat-fingers a
 * threshold must be told, not silently given the default. So the write path validates
 * STRICTLY and REJECTS out-of-range input, and the route echoes back the effective
 * parsed config so the admin sees exactly what took effect.
 *
 * Ranges are derived from the scorer (cluster-legitimacy.ts), NOT guessed:
 *   - score = Σ(weight·band)/Σweight ⇒ weights need only be finite ≥ 0 (the
 *     high≥medium≥low ordering is the cost-to-fake INTENT, a warning not an error).
 *   - norm(x,cap) returns 0 when cap ≤ 0 (a non-positive cap silently disables a
 *     signal) ⇒ caps must be > 0.
 *   - thresholds compared against [0,1] scores / a 64-bit Hamming distance / a
 *     fraction ⇒ their ranges below.
 *
 * Pure (no IO) so the rules are fixture-locked before they gate a live config write.
 * SoT: plans/id-block-corroboration-source-independence.md §5.
 */

import type { IdBlockConfig, QuarantineMode } from "./config";

export interface ConfigValidationOk {
  ok: true;
  /** the canonical IdBlockConfig to persist (built from the validated values). */
  config: IdBlockConfig;
  /** non-blocking advisories (e.g. weight ordering). */
  warnings: string[];
}
export interface ConfigValidationErr {
  ok: false;
  errors: string[];
}
export type ConfigValidationResult = ConfigValidationOk | ConfigValidationErr;

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Validate a full submitted IdBlockConfig. Returns the canonical config to store on
 * success (with warnings) or the list of human-readable errors on failure. The editor
 * submits the WHOLE config (it loaded the full config, edited fields, re-submits all).
 */
export function validateIdBlockConfigInput(raw: unknown): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const root = asObj(raw);
  if (!root) return { ok: false, errors: ["config must be a JSON object"] };

  const num = (
    obj: Record<string, unknown> | null,
    key: string,
    label: string,
    opts: { min?: number; max?: number; integer?: boolean; exclusiveMin?: number } = {},
  ): number | null => {
    const v = obj?.[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      errors.push(`${label} must be a finite number`);
      return null;
    }
    if (opts.integer && !Number.isInteger(v)) errors.push(`${label} must be an integer`);
    if (opts.min !== undefined && v < opts.min) errors.push(`${label} must be ≥ ${opts.min}`);
    if (opts.exclusiveMin !== undefined && v <= opts.exclusiveMin) errors.push(`${label} must be > ${opts.exclusiveMin}`);
    if (opts.max !== undefined && v > opts.max) errors.push(`${label} must be ≤ ${opts.max}`);
    return v;
  };

  const weights = asObj(root.weights);
  if (!weights) errors.push("weights must be an object");
  const wHigh = num(weights, "high", "weights.high", { min: 0 });
  const wMed = num(weights, "medium", "weights.medium", { min: 0 });
  const wLow = num(weights, "low", "weights.low", { min: 0 });
  if (wHigh !== null && wMed !== null && wLow !== null) {
    if (wHigh + wMed + wLow <= 0) errors.push("weights cannot all be zero (the legitimacy score would collapse to defaults)");
    else if (!(wHigh >= wMed && wMed >= wLow)) {
      warnings.push("weights are not ordered high ≥ medium ≥ low — the score math still holds, but this inverts the cost-to-fake intent");
    }
  }

  const caps = asObj(root.normCaps);
  if (!caps) errors.push("normCaps must be an object");
  num(caps, "accountAgeDaysCap", "normCaps.accountAgeDaysCap", { exclusiveMin: 0 });
  num(caps, "signupLatencyDaysCap", "normCaps.signupLatencyDaysCap", { exclusiveMin: 0 });
  num(caps, "activityBreadthCap", "normCaps.activityBreadthCap", { exclusiveMin: 0 });

  const shape = asObj(root.shape);
  if (!shape) errors.push("shape must be an object");
  num(shape, "thinScore", "shape.thinScore", { min: 0, max: 1 });
  num(shape, "burstWindowHours", "shape.burstWindowHours", { exclusiveMin: 0 });
  num(shape, "signupCorrelationWindowHours", "shape.signupCorrelationWindowHours", { exclusiveMin: 0 });

  const gate = asObj(root.gate);
  if (!gate) errors.push("gate must be an object");
  num(gate, "clusterLegitimacyThreshold", "gate.clusterLegitimacyThreshold", { min: 0, max: 1 });
  num(gate, "hammingNearDupThreshold", "gate.hammingNearDupThreshold", { min: 0, max: 64, integer: true });
  num(gate, "sameContentMajority", "gate.sameContentMajority", { exclusiveMin: 0, max: 1 });
  const mode = gate?.mode;
  if (mode !== "shadow" && mode !== "active") errors.push("gate.mode must be 'shadow' or 'active'");

  const slack = asObj(root.slack);
  if (!slack) errors.push("slack must be an object");
  else if (typeof slack.enabled !== "boolean") errors.push("slack.enabled must be a boolean");

  if (errors.length > 0) return { ok: false, errors };

  const config: IdBlockConfig = {
    weights: { high: wHigh as number, medium: wMed as number, low: wLow as number },
    normCaps: {
      accountAgeDaysCap: caps!.accountAgeDaysCap as number,
      signupLatencyDaysCap: caps!.signupLatencyDaysCap as number,
      activityBreadthCap: caps!.activityBreadthCap as number,
    },
    shape: {
      thinScore: shape!.thinScore as number,
      burstWindowHours: shape!.burstWindowHours as number,
      signupCorrelationWindowHours: shape!.signupCorrelationWindowHours as number,
    },
    gate: {
      clusterLegitimacyThreshold: gate!.clusterLegitimacyThreshold as number,
      hammingNearDupThreshold: gate!.hammingNearDupThreshold as number,
      sameContentMajority: gate!.sameContentMajority as number,
      mode: mode as QuarantineMode,
    },
    slack: { enabled: slack!.enabled as boolean },
  };
  return { ok: true, config, warnings };
}
