/**
 * Ship Gate G6 fixture — CF-40 v4 flag-config-backed thresholds. PURE; no DB;
 * deterministic; manually runnable.
 *
 *   npx tsx scripts/cf40-v4-config-fixture.ts
 *
 * Locks the config layer (config.ts):
 *   A. empty / null / malformed config → the code defaults (byte-identical to pre-G6)
 *   B. DEFAULT_CF40V4_CONFIG IS the per-module constants (single source of truth —
 *      the migration seeds config={} so this is the only default snapshot)
 *   C. an override actually FLOWS through the pure evaluators (config-backing is not
 *      cosmetic) — and never mutates the DEFAULT
 *   D. partial / nested overrides merge leaf-wise (untouched leaves stay default)
 *   E. wrong-typed values are ignored (fall back, never corrupt the shape)
 *
 * The behavioral byte-identical proof for the evaluators THEMSELVES (defaults ===
 * legacy behavior) is the 224-assertion all-fixtures suite — every pure fn is run
 * there with default params. This suite proves the config plumbing on top of it.
 */

import {
  DEFAULT_CF40V4_CONFIG,
  parseCF40V4Config,
} from "@/lib/parser/cf40-v4/config";
import {
  CORROBORATION_THRESHOLDS,
  RAPID_CHANGE_THRESHOLDS,
  REPARSE_SAMPLING,
  SUPERMAJORITY_SHARES,
  supermajorityThreshold,
} from "@/lib/parser/cf40-v4/scale-thresholds";
import { TRUST_WEIGHT, getScaleTier, type ValidityGateInput } from "@/lib/parser/cf40-v4/types";
import { effectiveWeight } from "@/lib/parser/cf40-v4/trust-weight";
import { evaluateValidityGates, VALIDITY_THRESHOLDS } from "@/lib/parser/cf40-v4/validity-gates";
import { decideForcedReparse } from "@/lib/parser/cf40-v4/forced-reparse";
import { passesCoverageGate, DEFAULT_COVERAGE_CONFIG } from "@/lib/parser/doctype-expected-counts";

// ── tiny harness ──────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const json = (x: unknown) => JSON.stringify(x);
const validityInput = (selfCheck: number): ValidityGateInput => ({
  selfCheckPassRate: selfCheck,
  ocrConfidence: null,
  classificationConfidence: null,
  uploadedAt: new Date().toISOString(),
  documentPlanYear: new Date().getUTCFullYear(),
  fileSizeBytes: 100_000,
  docType: "sbc",
  uploaderTier: "phone_email_verified",
  isAdmin: false,
  isBanned: false,
  canonicalReBaselineRequired: false,
});
const forcedInput = (smartSkipCount: number) => ({
  isAdmin: false,
  scaleTier: "small" as const,
  smartSkipCount,
  lastFullParseAt: null,
  divergencePendingVerification: false,
  adminAttestedNeedsValidation: false,
});

// ── A. empty / null / malformed → defaults ────────────────────────────────────
console.log("[A] empty / null / malformed → defaults");
check("parseCF40V4Config({}) deep-equals DEFAULT", json(parseCF40V4Config({})) === json(DEFAULT_CF40V4_CONFIG));
check("parseCF40V4Config(null) === DEFAULT", parseCF40V4Config(null) === DEFAULT_CF40V4_CONFIG);
check("parseCF40V4Config(undefined) === DEFAULT", parseCF40V4Config(undefined) === DEFAULT_CF40V4_CONFIG);
check("parseCF40V4Config('garbage') === DEFAULT", parseCF40V4Config("garbage") === DEFAULT_CF40V4_CONFIG);
check("parseCF40V4Config(42) === DEFAULT", parseCF40V4Config(42) === DEFAULT_CF40V4_CONFIG);

// ── B. DEFAULT === per-module constants (single source of truth) ──────────────
console.log("[B] DEFAULT === per-module constants");
check("DEFAULT.corroboration === CORROBORATION_THRESHOLDS", DEFAULT_CF40V4_CONFIG.corroboration === CORROBORATION_THRESHOLDS);
check("DEFAULT.rapidChange === RAPID_CHANGE_THRESHOLDS", DEFAULT_CF40V4_CONFIG.rapidChange === RAPID_CHANGE_THRESHOLDS);
check("DEFAULT.reparseSampling === REPARSE_SAMPLING", DEFAULT_CF40V4_CONFIG.reparseSampling === REPARSE_SAMPLING);
check("DEFAULT.weights.trust === TRUST_WEIGHT", DEFAULT_CF40V4_CONFIG.weights.trust === TRUST_WEIGHT);
check("DEFAULT.coverage === DEFAULT_COVERAGE_CONFIG", DEFAULT_CF40V4_CONFIG.coverage === DEFAULT_COVERAGE_CONFIG);
check(
  "DEFAULT.supermajority.coldStart === SUPERMAJORITY_SHARES.coldStart === 0.80",
  DEFAULT_CF40V4_CONFIG.supermajority.coldStart === SUPERMAJORITY_SHARES.coldStart && SUPERMAJORITY_SHARES.coldStart === 0.80,
);
check("DEFAULT.scale.coldStartMax === 100", DEFAULT_CF40V4_CONFIG.scale.coldStartMax === 100);
check(
  "DEFAULT.validity.selfCheckPassRate === VALIDITY_THRESHOLDS === 0.95",
  DEFAULT_CF40V4_CONFIG.validity.selfCheckPassRate === VALIDITY_THRESHOLDS.selfCheckPassRate && VALIDITY_THRESHOLDS.selfCheckPassRate === 0.95,
);
check("DEFAULT.slowDrift.divergenceRate30dThreshold === 0.3", DEFAULT_CF40V4_CONFIG.slowDrift.divergenceRate30dThreshold === 0.3);
check("DEFAULT.plausibility === {min:0.2,max:5.0}", DEFAULT_CF40V4_CONFIG.plausibility.min === 0.2 && DEFAULT_CF40V4_CONFIG.plausibility.max === 5.0);
check("DEFAULT.minorityRouter === {2,0}", DEFAULT_CF40V4_CONFIG.minorityRouter.minVerifiedUsers === 2 && DEFAULT_CF40V4_CONFIG.minorityRouter.minMinorityWeight === 0);
check("DEFAULT.adminAttestation.minUploadsPerDocType === 2", DEFAULT_CF40V4_CONFIG.adminAttestation.minUploadsPerDocType === 2);
check("DEFAULT.forcedReparse.everyNthSmartSkip === 5", DEFAULT_CF40V4_CONFIG.forcedReparse.everyNthSmartSkip === 5);
check("DEFAULT.weights.stabilityThreshold === 3.0", DEFAULT_CF40V4_CONFIG.weights.stabilityThreshold === 3.0);
check("DEFAULT.weights.timeDecayBracketDays.recentMaxDays === 90", DEFAULT_CF40V4_CONFIG.weights.timeDecayBracketDays.recentMaxDays === 90);

// ── C. an override FLOWS through the pure evaluators ──────────────────────────
console.log("[C] override flows through evaluators");
const overSuper = parseCF40V4Config({ supermajority: { coldStart: 0.95 } });
check("override supermajority.coldStart=0.95 → supermajorityThreshold(50,cold_start)=0.95", supermajorityThreshold(50, "cold_start", overSuper.supermajority) === 0.95);
check("default supermajorityThreshold(50,cold_start) still 0.80", supermajorityThreshold(50, "cold_start") === 0.80);

const overScale = parseCF40V4Config({ scale: { coldStartMax: 5 } });
check("override scale.coldStartMax=5 → getScaleTier(50)=small", getScaleTier(50, overScale.scale) === "small");
check("default getScaleTier(50) still cold_start", getScaleTier(50) === "cold_start");

const overVal = parseCF40V4Config({ validity: { selfCheckPassRate: 0.5 } });
check(
  "override validity.selfCheckPassRate=0.5 → a 0.6 self-check no longer fails that gate",
  !evaluateValidityGates(validityInput(0.6), overVal.validity).failureReasons.includes("self_check_pass_rate_below_threshold"),
);
check(
  "default validity (0.95) → a 0.6 self-check FAILS the self-check gate",
  evaluateValidityGates(validityInput(0.6)).failureReasons.includes("self_check_pass_rate_below_threshold"),
);

const overW = parseCF40V4Config({ weights: { trust: { admin: 10 } } });
check("override weights.trust.admin=10 → effectiveWeight(admin,0)=10", effectiveWeight("admin", 0, overW.weights) === 10);
check("default effectiveWeight(admin,0)=3.0", effectiveWeight("admin", 0) === 3.0);

const overF = parseCF40V4Config({ forcedReparse: { everyNthSmartSkip: 3 } });
check("override forcedReparse.everyNth=3 → smartSkipCount 3 forces", decideForcedReparse(forcedInput(3), overF).forceFullParse === true);
check("default everyNth=5 → smartSkipCount 3 does NOT force", decideForcedReparse(forcedInput(3)).forceFullParse === false);

// score for (sbc, vsc=6/12 idCov=0.5, vsvc=8/8 svcCov=1) = 0.5*0.5 + 0.5*1 = 0.75
const overCov = parseCF40V4Config({ coverage: { thresholds: { sbc: 0.7 } } });
check("override coverage.thresholds.sbc=0.70 → a 0.75 score passes", passesCoverageGate("sbc", 6, 8, [8], overCov.coverage) === true);
check("default coverage sbc=0.80 → a 0.75 score fails", passesCoverageGate("sbc", 6, 8, [8]) === false);

check("DEFAULT.supermajority.coldStart unchanged after overrides (no mutation)", DEFAULT_CF40V4_CONFIG.supermajority.coldStart === 0.80);

// ── D. partial / nested overrides merge leaf-wise ─────────────────────────────
console.log("[D] partial / nested merge");
const partial = parseCF40V4Config({ supermajority: { coldStart: 0.7 } });
check("partial: coldStart=0.7", partial.supermajority.coldStart === 0.7);
check("partial: small still 0.66 (default)", partial.supermajority.small === 0.66);
check("partial: other sections intact (scale.coldStartMax=100)", partial.scale.coldStartMax === 100);
const nested = parseCF40V4Config({ corroboration: { cold_start: { distinctUsers: 9 } } });
check("nested: corroboration.cold_start.distinctUsers=9", nested.corroboration.cold_start.distinctUsers === 9);
check("nested: corroboration.cold_start.totalUploads still 5", nested.corroboration.cold_start.totalUploads === 5);
check("nested: corroboration.small untouched (distinctUsers=5)", nested.corroboration.small.distinctUsers === 5);
const nullable = parseCF40V4Config({ corroboration: { cold_start: { ipBlocks: 3 } } });
check("nullable leaf: cold_start.ipBlocks null→3", nullable.corroboration.cold_start.ipBlocks === 3);

// ── E. wrong-typed values ignored ─────────────────────────────────────────────
console.log("[E] malformed values ignored");
const bad = parseCF40V4Config({
  supermajority: { coldStart: "nope" },
  scale: "garbage",
  bogusKey: 5,
  weights: { trust: { admin: null } },
});
check("malformed coldStart string → default 0.80", bad.supermajority.coldStart === 0.80);
check("malformed scale string → default object (coldStartMax=100)", bad.scale.coldStartMax === 100);
check("unknown key ignored (shape intact: minorityRouter=2)", bad.minorityRouter.minVerifiedUsers === 2);
check("number leaf rejects null (weights.trust.admin → default 3.0)", bad.weights.trust.admin === 3.0);

// ── summary ───────────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? "✅" : "❌"} cf40-v4-config fixture: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
