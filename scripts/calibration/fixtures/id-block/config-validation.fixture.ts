/**
 * ID-Block PR3b-2 config-validation fixture (Ship Gate G4).
 *
 * Locks validateIdBlockConfigInput: a valid full config passes (with the canonical
 * config echoed back); each out-of-range field is REJECTED (not silently coerced);
 * weight-ordering is a warning, not an error.
 *
 * Run:
 *   cd /Users/andrewullmann/Desktop/candid
 *   npx tsx scripts/calibration/fixtures/id-block/config-validation.fixture.ts
 *
 * Pass criteria: all cases PASS. Exit 0 on PASS, 1 on any failure.
 */

import { validateIdBlockConfigInput } from "../../../../src/lib/parser/id-block/config-validation";

function base(): Record<string, unknown> {
  return {
    weights: { high: 1.0, medium: 0.5, low: 0.2 },
    normCaps: { accountAgeDaysCap: 180, signupLatencyDaysCap: 30, activityBreadthCap: 8 },
    shape: { thinScore: 0.35, burstWindowHours: 72, signupCorrelationWindowHours: 48 },
    gate: { clusterLegitimacyThreshold: 0.35, hammingNearDupThreshold: 3, sameContentMajority: 0.5, mode: "shadow" },
    // S319 fixture audit — the validator grew the PR3c reEval block (cadence +
    // sweep bound) and this base config predated it; three cases failed on
    // "reEval must be an object". Values mirror the shipped defaults.
    reEval: { cadenceDays: 1, maxRowsPerSweep: 100 },
    slack: { enabled: true },
  };
}
// deep-clone + apply a mutation by group/key
function mut(grp: string, key: string, val: unknown): Record<string, unknown> {
  const c = base();
  (c[grp] as Record<string, unknown>)[key] = val;
  return c;
}

interface Case {
  name: string;
  run: () => boolean;
  detail?: () => string;
}

const cases: Case[] = [
  {
    name: "valid full config → ok, no warnings, echoes canonical config",
    run: () => {
      const r = validateIdBlockConfigInput(base());
      return r.ok && r.warnings.length === 0 && r.config.gate.mode === "shadow" && r.config.weights.high === 1.0;
    },
  },
  {
    name: "active mode is valid (editor can set it; flipping is the operator's call)",
    run: () => {
      const r = validateIdBlockConfigInput(mut("gate", "mode", "active"));
      return r.ok && r.config.gate.mode === "active";
    },
  },
  {
    name: "weights not ordered (high<medium) → OK but WARNING (math holds)",
    run: () => {
      const r = validateIdBlockConfigInput({ ...base(), weights: { high: 0.2, medium: 0.5, low: 0.2 } });
      return r.ok && r.warnings.length === 1;
    },
    detail: () => JSON.stringify(validateIdBlockConfigInput({ ...base(), weights: { high: 0.2, medium: 0.5, low: 0.2 } })),
  },
  {
    name: "all weights zero → ERROR (score would collapse)",
    run: () => {
      const r = validateIdBlockConfigInput({ ...base(), weights: { high: 0, medium: 0, low: 0 } });
      return !r.ok && r.errors.some((e) => e.includes("weights cannot all be zero"));
    },
  },
  {
    name: "negative weight → ERROR",
    run: () => !validateIdBlockConfigInput(mut("weights", "high", -1)).ok,
  },
  {
    name: "cap ≤ 0 → ERROR (a non-positive cap silently disables the signal)",
    run: () => {
      const r = validateIdBlockConfigInput(mut("normCaps", "accountAgeDaysCap", 0));
      return !r.ok && r.errors.some((e) => e.includes("accountAgeDaysCap") && e.includes("> 0"));
    },
  },
  {
    name: "clusterLegitimacyThreshold > 1 → ERROR",
    run: () => !validateIdBlockConfigInput(mut("gate", "clusterLegitimacyThreshold", 1.5)).ok,
  },
  {
    name: "clusterLegitimacyThreshold < 0 → ERROR",
    run: () => !validateIdBlockConfigInput(mut("gate", "clusterLegitimacyThreshold", -0.1)).ok,
  },
  {
    name: "hammingNearDupThreshold non-integer → ERROR",
    run: () => {
      const r = validateIdBlockConfigInput(mut("gate", "hammingNearDupThreshold", 3.5));
      return !r.ok && r.errors.some((e) => e.includes("hammingNearDupThreshold") && e.includes("integer"));
    },
  },
  {
    name: "hammingNearDupThreshold > 64 → ERROR",
    run: () => !validateIdBlockConfigInput(mut("gate", "hammingNearDupThreshold", 65)).ok,
  },
  {
    name: "sameContentMajority = 0 → ERROR (exclusive min)",
    run: () => !validateIdBlockConfigInput(mut("gate", "sameContentMajority", 0)).ok,
  },
  {
    name: "sameContentMajority > 1 → ERROR",
    run: () => !validateIdBlockConfigInput(mut("gate", "sameContentMajority", 1.2)).ok,
  },
  {
    name: "thinScore > 1 → ERROR",
    run: () => !validateIdBlockConfigInput(mut("shape", "thinScore", 1.5)).ok,
  },
  {
    name: "burstWindowHours ≤ 0 → ERROR",
    run: () => !validateIdBlockConfigInput(mut("shape", "burstWindowHours", 0)).ok,
  },
  {
    name: "gate.mode invalid → ERROR",
    run: () => !validateIdBlockConfigInput(mut("gate", "mode", "off")).ok,
  },
  {
    name: "slack.enabled non-boolean → ERROR",
    run: () => !validateIdBlockConfigInput(mut("slack", "enabled", "yes")).ok,
  },
  {
    name: "NaN threshold (cleared field) → ERROR (must be finite)",
    run: () => !validateIdBlockConfigInput(mut("gate", "clusterLegitimacyThreshold", NaN)).ok,
  },
  {
    name: "non-object → ERROR",
    run: () => !validateIdBlockConfigInput("nope").ok && !validateIdBlockConfigInput(null).ok,
  },
  {
    name: "missing group (no gate) → ERROR",
    run: () => {
      const c = base();
      delete c.gate;
      return !validateIdBlockConfigInput(c).ok;
    },
  },
];

let failed = 0;
for (const c of cases) {
  let ok = false;
  let err = "";
  try {
    ok = c.run();
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  const extra = c.detail && (!ok || process.env.VERBOSE) ? `  [${c.detail()}]` : "";
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}${extra}${err ? `  (threw: ${err})` : ""}`);
  if (!ok) failed++;
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed === 0 ? 0 : 1);
