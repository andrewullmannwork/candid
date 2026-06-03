/**
 * Ing-D.0c-ii fixture — CF-40 v4 Layer 4 rapid-change (§2.7b) + verification-mode
 * (§2.7c). The robustness proof (Andrew S159 critical review): the suites below
 * lock the pure decision logic for EVERY branch, including the adversarial cases
 * that distinguish the robust design from a naive one.
 *
 * Three PURE suites (no DB; deterministic; manually runnable):
 *   A. computeRapidChange — the §2.7b detector. auto_fire ONLY on a plausible,
 *      scale-sufficient, DIVERSE convergence; cold_start + diversity-unmeasurable +
 *      diversity-unmet all route to admin_review; implausible / scattered / count-
 *      below all → none. Conservative-by-design (never auto-un-promotes on noise).
 *   B. resolveVerificationDecision — the robustness CORE. Consecutive agreement on
 *      the stored challenger → drift; a SECOND DIFFERENT value (noise masquerading
 *      as drift) → noise; reaffirmed baseline → noise; null challenger → noise.
 *   C. verification-OPEN gates + primitives — tupleDivergesFromBaseline,
 *      divergingFieldsPlausible (won't open on garbage), withinPlausibility,
 *      identityTupleEqual.
 *
 * Run:  npx tsx scripts/cf40-v4-rapid-change-and-verification-fixture.ts
 *
 * Ship Gate G4 (block_ship_gate.md). The IO wrappers (detectRapidChange /
 * detectVerificationMode writes) are exercised by the read-only dry-run + smoke;
 * this suite locks the pure decisions so a regression fails loudly + offline.
 */

import {
  computeRapidChange,
  resolveVerificationDecision,
  tupleDivergesFromBaseline,
  divergingFieldsPlausible,
  withinPlausibility,
  identityTupleEqual,
  RAPID_CHANGE_THRESHOLDS,
  type DriftExtractionRow,
  type DiversityMeasure,
  type IdentityTuple,
} from "@/lib/parser/cf40-v4";

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

const DED = "in_deductible_individual";
const T1 = "2026-05-30T00:00:00.000Z";

/** served baseline keyed by in_-prefixed extractionField. */
const BASELINE: Record<string, number | null> = {
  in_deductible_individual: 2000,
  in_deductible_family: 4000,
  in_oop_max_individual: 8000,
  in_oop_max_family: 16000,
};

/** N deductible rows at `value`, one per distinct user. */
function ded(value: number, n: number, startUser = 0): DriftExtractionRow[] {
  return Array.from({ length: n }, (_, i) => ({
    extractionField: DED,
    userId: `u${startUser + i}`,
    value,
    createdAt: T1,
  }));
}

const NO_DIVERSITY: DiversityMeasure = { ipBlocks: null, asns: null, emailDomains: null };
const SMALL = RAPID_CHANGE_THRESHOLDS.small; // distinctUsers 5; emailDomains 2; requiresAdminReview false
const COLD = RAPID_CHANGE_THRESHOLDS.cold_start; // distinctUsers 3; ipBlocks 2; requiresAdminReview true

function tuple(dedInd: number | null): IdentityTuple {
  return {
    in_deductible_individual: dedInd,
    in_deductible_family: 4000,
    in_oop_max_individual: 8000,
    in_oop_max_family: 16000,
  };
}

console.log("\n=== Suite A — computeRapidChange (§2.7b detector) ===");

// A1 — AUTO-FIRE: small scale; 6 converge on a plausible challenger; diversity MET.
{
  const r = computeRapidChange({
    rows: [...ded(3000, 6, 0), ...ded(2000, 2, 6)], // 6 challenger + 2 baseline
    baseline: BASELINE,
    thresholds: SMALL,
    diversity: { ipBlocks: null, asns: null, emailDomains: 3 }, // required 2, met
  });
  check("A1 auto_fire (6 converge, plausible, diversity met)", r.disposition === "auto_fire", r.disposition);
  check("A1 challenger=3000 worstField=deductible", r.challengerValue === 3000 && r.worstField === DED);
  check("A1 convergingUserCount=6", r.convergingUserCount === 6, String(r.convergingUserCount));
}

// A2 — ADMIN REVIEW: same convergence but diversity UNMEASURABLE (the IO reality today).
{
  const r = computeRapidChange({
    rows: [...ded(3000, 6, 0), ...ded(2000, 2, 6)],
    baseline: BASELINE,
    thresholds: SMALL,
    diversity: NO_DIVERSITY,
  });
  check("A2 admin_review (diversity unmeasurable → conservative)", r.disposition === "admin_review", r.disposition);
  check("A2 diversityMeasurable=false", r.diversityMeasurable === false);
}

// A3 — ADMIN REVIEW: diversity present but NOT met (looks coordinated → don't auto-fire).
{
  const r = computeRapidChange({
    rows: ded(3000, 6, 0),
    baseline: BASELINE,
    thresholds: SMALL,
    diversity: { ipBlocks: null, asns: null, emailDomains: 1 }, // required 2, not met
  });
  check("A3 admin_review (diversity unmet)", r.disposition === "admin_review", r.disposition);
}

// A4 — ADMIN REVIEW at cold_start, ALWAYS (even with diversity satisfied).
{
  const r = computeRapidChange({
    rows: ded(3000, 4, 0), // 4 ≥ cold_start 3
    baseline: BASELINE,
    thresholds: COLD,
    diversity: { ipBlocks: 9, asns: null, emailDomains: null },
  });
  check("A4 admin_review at cold_start (requiresAdminReview)", r.disposition === "admin_review", r.disposition);
}

// A5 — NONE: count below threshold (2 < cold_start 3).
{
  const r = computeRapidChange({ rows: ded(3000, 2, 0), baseline: BASELINE, thresholds: COLD, diversity: NO_DIVERSITY });
  check("A5 none (count below threshold)", r.disposition === "none", r.disposition);
}

// A6 — NONE: implausible challenger ($50 vs $2000 baseline → < 0.2×) even with count met.
{
  const r = computeRapidChange({ rows: ded(50, 8, 0), baseline: BASELINE, thresholds: SMALL, diversity: { ipBlocks: null, asns: null, emailDomains: 9 } });
  check("A6 none (implausible challenger rejected)", r.disposition === "none", r.disposition);
  check("A6 plausible=false", r.plausible === false);
}

// A7 — NONE: everyone agrees with the baseline (no challenger at all).
{
  const r = computeRapidChange({ rows: ded(2000, 8, 0), baseline: BASELINE, thresholds: SMALL, diversity: NO_DIVERSITY });
  check("A7 none (all agree with baseline)", r.disposition === "none" && r.evaluated === false, r.disposition);
}

// A8 — NONE: scattered divergence (8 DIFFERENT values) is not CONVERGENCE.
{
  const scattered: DriftExtractionRow[] = [2500, 2600, 2700, 2800, 2900, 3100, 3200, 3300].map((v, i) => ({
    extractionField: DED,
    userId: `u${i}`,
    value: v,
    createdAt: T1,
  }));
  const r = computeRapidChange({ rows: scattered, baseline: BASELINE, thresholds: SMALL, diversity: { ipBlocks: null, asns: null, emailDomains: 9 } });
  check("A8 none (scattered divergence ≠ convergence)", r.disposition === "none", `${r.disposition} converging=${r.convergingUserCount}`);
}

console.log("\n=== Suite B — resolveVerificationDecision (the robustness CORE) ===");
{
  const challenger = tuple(3000);
  const baselineTuple = tuple(2000);

  // B1 — consecutive AGREEMENT on the challenger → drift.
  check("B1 drift (parse == challenger, confirmed twice)", resolveVerificationDecision(tuple(3000), challenger) === "drift");

  // B2 — reaffirmed baseline → noise.
  check("B2 noise (parse == baseline, reaffirmed)", resolveVerificationDecision(baselineTuple, challenger) === "noise");

  // B3 — ★ THE robustness case: a SECOND, DIFFERENT divergent value is NOISE, not
  //      drift. "any divergence from baseline" would FALSE-re-baseline here.
  check("B3 noise (third distinct value — noise masquerading as drift)", resolveVerificationDecision(tuple(5000), challenger) === "noise");

  // B4 — null challenger (no open event) → safe default noise.
  check("B4 noise (null challenger → safe default)", resolveVerificationDecision(tuple(3000), null) === "noise");
}

console.log("\n=== Suite C — verification-OPEN gates + primitives ===");
{
  // C1/C2 — divergence vs baseline.
  check("C1 no divergence (parse == baseline)", tupleDivergesFromBaseline(tuple(2000), BASELINE) === false);
  check("C2 diverges (deductible 3000)", tupleDivergesFromBaseline(tuple(3000), BASELINE) === true);

  // C3/C4/C5 — verification only OPENS on a PLAUSIBLE divergence (won't open on garbage).
  check("C3 plausible divergence opens (3000)", divergingFieldsPlausible(tuple(3000), BASELINE) === true);
  check("C4 implausible-low does NOT open (50)", divergingFieldsPlausible(tuple(50), BASELINE) === false);
  check("C5 implausible-high does NOT open (100000)", divergingFieldsPlausible(tuple(100000), BASELINE) === false);

  // C6 — withinPlausibility primitive.
  check("C6a within band (3000 of 2000)", withinPlausibility(3000, 2000, 0.2, 5.0) === true);
  check("C6b below band (50 of 2000)", withinPlausibility(50, 2000, 0.2, 5.0) === false);
  check("C6c above band (11000 of 2000)", withinPlausibility(11000, 2000, 0.2, 5.0) === false);
  check("C6d degenerate $0 baseline defers (plausible=true)", withinPlausibility(3000, 0, 0.2, 5.0) === true);

  // C7 — identityTupleEqual primitive.
  check("C7a equal tuples", identityTupleEqual(tuple(2000), tuple(2000)) === true);
  check("C7b one field differs", identityTupleEqual(tuple(2000), tuple(3000)) === false);
  check("C7c null → false", identityTupleEqual(tuple(2000), null) === false);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} rapid-change + verification fixture: ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
