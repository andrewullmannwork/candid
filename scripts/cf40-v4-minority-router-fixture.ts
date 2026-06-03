/**
 * Ing-D.0d fixture — CF-40 v4 Layer 3(b) minority-candidate router. PURE; no DB;
 * deterministic; manually runnable.
 *
 *   npx tsx scripts/cf40-v4-minority-router-fixture.ts
 *
 * Locks the pure decision surface (Ship Gate G4): `computeLayer3Inputs` surfacing the
 * baseline tuple + non-baseline minorities (the dropped-by-v3 dissenters),
 * `diffMinorityFields` (per-field decomposition), and `buildMinorityReviewRows` (the
 * gates + plausibility STAMP + dedup-key derivation + JSONB shape). The IO wrapper
 * `routeMinorityCandidates` + the shared idempotent `upsertDivergenceReview` are
 * exercised by the read-only dry-run + smoke; this suite locks the decisions so a
 * regression fails loudly + offline.
 *
 * Suites:
 *   A. computeLayer3Inputs — baseline = max-weight tuple; minorities = the rest;
 *      ties surface the other half; single-user / all-agree produce no minority.
 *   B. diffMinorityFields — only differing fields; null distinguished from 0/value.
 *   C. buildMinorityReviewRows — ≥2-verified-user gate; weight floor (tunable);
 *      plausibility STAMP (not filter); '∅' key for null; multi-field fan-out; JSONB
 *      context (co_occurring_tuple + baseline_tuple + plausible).
 */

import {
  computeLayer3Inputs,
  diffMinorityFields,
  buildMinorityReviewRows,
  type AggPlanRow,
  type AggUserTrust,
} from "@/lib/parser/cf40-v4/doctype-promotion-aggregator";
import type { IdentityTuple } from "@/lib/parser/cf40-v4";

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

const NOW = new Date("2026-06-02T00:00:00.000Z");
const RECENT = "2026-05-20T00:00:00.000Z"; // ~13d → time-decay bracket 0_90d → weight ×1.0

/** A full identity tuple (4 in_ scalars). */
function tup(
  dedInd: number | null,
  dedFam: number | null,
  oopInd: number | null,
  oopFam: number | null,
): IdentityTuple {
  return {
    in_deductible_individual: dedInd,
    in_deductible_family: dedFam,
    in_oop_max_individual: oopInd,
    in_oop_max_family: oopFam,
  };
}

function row(planId: string, userId: string, t: IdentityTuple, createdAt = RECENT): AggPlanRow {
  return { planId, userId, createdAt, fieldProvenance: null, identityValues: t };
}

/** All users phone+email verified, non-admin (the organic corroboration denominator). */
function verifiedUsers(ids: string[]): Map<string, AggUserTrust> {
  const m = new Map<string, AggUserTrust>();
  for (const id of ids) m.set(id, { isAdmin: false, emailVerified: true, phoneVerified: true });
  return m;
}

function inputsFrom(rows: AggPlanRow[], userIds: string[]) {
  return computeLayer3Inputs({
    docType: "sbc",
    planRows: rows,
    userById: verifiedUsers(userIds),
    extractionCount: rows.length, // cold_start tier
    serviceCountByPlanId: new Map(),
    verifiedServiceCount: 0,
    now: NOW,
  });
}

const A = tup(2000, 4000, 8000, 16000); // the majority tuple
const B = tup(2500, 4000, 8000, 16000); // dissents on deductible_individual only

// ── Suite A — computeLayer3Inputs minority surfacing ─────────────────────────
console.log("\nA. computeLayer3Inputs — baseline + minorities");
{
  // 2 users on A, 1 on B → baseline A (w=2.0), one minority B (w=1.0), total 3.0.
  const inp = inputsFrom(
    [row("p1", "u1", A), row("p2", "u2", A), row("p3", "u3", B)],
    ["u1", "u2", "u3"],
  );
  check("baseline tuple = A", JSON.stringify(inp.baselineTuple) === JSON.stringify(A));
  check("exactly one minority", inp.minorities.length === 1);
  check("minority tuple = B", JSON.stringify(inp.minorities[0]?.tuple) === JSON.stringify(B));
  check("minority weight = 1.0", inp.minorities[0]?.weight === 1.0, `got ${inp.minorities[0]?.weight}`);
  check("minority userIds = [u3]", JSON.stringify(inp.minorities[0]?.userIds) === JSON.stringify(["u3"]));
  check("total weight = 3.0", inp.supermajority.totalWeight === 3.0, `got ${inp.supermajority.totalWeight}`);
  check("baseline weight = 2.0", inp.supermajority.baselineWeight === 2.0);
}
{
  // All agree → no minority.
  const inp = inputsFrom([row("p1", "u1", A), row("p2", "u2", A)], ["u1", "u2"]);
  check("all-agree → 0 minorities", inp.minorities.length === 0);
  check("all-agree → baseline A", JSON.stringify(inp.baselineTuple) === JSON.stringify(A));
}
{
  // Single user → baseline set, no minority.
  const inp = inputsFrom([row("p1", "u1", A)], ["u1"]);
  check("single-user → 0 minorities", inp.minorities.length === 0);
}
{
  // 1 vs 1 tie → first-seen is baseline, the other surfaces (the 50/50 we WANT to see).
  const inp = inputsFrom([row("p1", "u1", A), row("p2", "u2", B)], ["u1", "u2"]);
  check("tie → baseline = first-seen A", JSON.stringify(inp.baselineTuple) === JSON.stringify(A));
  check("tie → 1 minority surfaced (B)", inp.minorities.length === 1 && JSON.stringify(inp.minorities[0]?.tuple) === JSON.stringify(B));
}

// ── Suite B — diffMinorityFields ─────────────────────────────────────────────
console.log("\nB. diffMinorityFields");
{
  const d = diffMinorityFields(A, B);
  check("single differing field", d.length === 1);
  check("field = in_deductible_individual", d[0]?.field === "in_deductible_individual");
  check("baseline 2000 / minority 2500", d[0]?.baselineValue === 2000 && d[0]?.minorityValue === 2500);
}
{
  const d = diffMinorityFields(A, tup(2500, 5000, 8000, 16000)); // 2 fields differ
  check("two differing fields", d.length === 2);
}
{
  const d = diffMinorityFields(A, A);
  check("identical tuples → no diffs", d.length === 0);
}
{
  // null IS a divergence from a value.
  const d = diffMinorityFields(A, tup(null, 4000, 8000, 16000));
  check("value→null counts as a divergence", d.length === 1 && d[0]?.minorityValue === null);
}

// ── Suite C — buildMinorityReviewRows ────────────────────────────────────────
console.log("\nC. buildMinorityReviewRows — gates + plausibility + key + JSONB");
{
  const inp = inputsFrom([row("p1", "u1", A), row("p2", "u2", A), row("p3", "u3", B)], ["u1", "u2", "u3"]);
  const rows = buildMinorityReviewRows("canon-1", "sbc", inp);
  check("one review row for the single-field minority", rows.length === 1);
  const r = rows[0];
  check("field_name = in_deductible_individual", r?.fieldName === "in_deductible_individual");
  check("dedup key = '2500'", r?.minorityValueKey === "2500");
  check("divergence_type = unclassified", r?.divergenceType === "unclassified");
  check("weight 1.0 / total 3.0", r?.minorityWeight === 1.0 && r?.totalWeight === 3.0);
  check("contributing users = [u3]", JSON.stringify(r?.contributingUserIds) === JSON.stringify(["u3"]));
  check("plausible stamp = true (2500 within [400,10000])", r?.minorityValueJsonb.plausible === true);
  check("jsonb carries co_occurring_tuple", JSON.stringify(r?.minorityValueJsonb.co_occurring_tuple) === JSON.stringify(B));
  check("jsonb carries baseline_tuple", JSON.stringify(r?.minorityValueJsonb.baseline_tuple) === JSON.stringify(A));
  check("jsonb source tag", r?.minorityValueJsonb.source === "layer3b_minority");
}
{
  // <2 verified users → no rows (single uploader / natural single-user state).
  const inp = inputsFrom([row("p1", "u1", A)], ["u1"]);
  check("single user → 0 rows", buildMinorityReviewRows("c", "sbc", inp).length === 0);
}
{
  // Implausible minority (10× baseline) is STILL surfaced, stamped implausible.
  const big = tup(20000, 4000, 8000, 16000);
  const inp = inputsFrom([row("p1", "u1", A), row("p2", "u2", A), row("p3", "u3", big)], ["u1", "u2", "u3"]);
  const rows = buildMinorityReviewRows("c", "sbc", inp);
  check("implausible minority surfaced (recall over precision)", rows.length === 1);
  check("implausible stamped plausible=false", rows[0]?.minorityValueJsonb.plausible === false);
}
{
  // null minority → key '∅', plausible false (not ratio-checkable).
  const inp = inputsFrom(
    [row("p1", "u1", A), row("p2", "u2", A), row("p3", "u3", tup(null, 4000, 8000, 16000))],
    ["u1", "u2", "u3"],
  );
  const rows = buildMinorityReviewRows("c", "sbc", inp);
  check("null minority → key '∅'", rows[0]?.minorityValueKey === "∅");
  check("null minority → plausible false", rows[0]?.minorityValueJsonb.plausible === false);
}
{
  // Multi-field minority → one row per differing field.
  const inp = inputsFrom(
    [row("p1", "u1", A), row("p2", "u2", A), row("p3", "u3", tup(2500, 5000, 8000, 16000))],
    ["u1", "u2", "u3"],
  );
  check("2-field minority → 2 rows", buildMinorityReviewRows("c", "sbc", inp).length === 2);
}
{
  // Tunable weight floor suppresses below-floor minorities (G6).
  const inp = inputsFrom([row("p1", "u1", A), row("p2", "u2", A), row("p3", "u3", B)], ["u1", "u2", "u3"]);
  const rows = buildMinorityReviewRows("c", "sbc", inp, { minVerifiedUsers: 2, minMinorityWeight: 5 });
  check("weight floor 5 suppresses the w=1 minority", rows.length === 0);
}

// ── summary ───────────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? "✅" : "❌"} minority-router fixture: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
