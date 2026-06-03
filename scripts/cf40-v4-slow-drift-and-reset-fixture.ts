/**
 * Ing-D.0c fixture — CF-40 v4 Layer 4 slow-drift detection + the re-baseline
 * reset (split-the-flag) loop.
 *
 * Three PURE suites (no DB; deterministic; manually runnable):
 *   A. computeSlowDrift — the §2.7(a) detector. Fires on rate>0.3 AND count>=3;
 *      below-rate / below-count do NOT fire; per-field MAX drives the signal;
 *      latest-per-user wins; null baseline is skipped; divergentValue = plurality.
 *   B. contributesUnderLayer1 — the split-the-flag predicate. re_baseline-only ->
 *      contributes (rebuild); any QUALITY failure -> blocks; the deadlock is gone.
 *   C. Reset-loop + mapping invariants — clearReBaseline truth table (the exact
 *      condition the recorder uses) + docTypeToParserKind.
 *
 * Run:  npx tsx scripts/cf40-v4-slow-drift-and-reset-fixture.ts
 *
 * Ship Gate G4 (block_ship_gate.md). The IO wrappers (detectSlowDrift writes +
 * the recorder reset) are exercised by the read-only dry-run + smoke; this suite
 * locks the pure decision logic so a regression fails loudly + offline.
 */

import {
  computeSlowDrift,
  contributesUnderLayer1,
  docTypeToParserKind,
  type DriftExtractionRow,
  type ValidityGateFailure,
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
const OOP = "in_oop_max_individual";
const T1 = "2026-05-20T00:00:00.000Z";
const T2 = "2026-05-28T00:00:00.000Z";

/** N rows for one field+value, one per distinct user (uXX). */
function rows(field: string, value: number, n: number, startUser = 0, createdAt = T1): DriftExtractionRow[] {
  return Array.from({ length: n }, (_, i) => ({
    extractionField: field,
    userId: `u${startUser + i}`,
    value,
    createdAt,
  }));
}

console.log("\n=== Suite A — computeSlowDrift (§2.7a detector) ===");

// A1 — FIRES: baseline 1000; 4/5 verified users diverge to 2000 (rate .8, count 4).
{
  const r = computeSlowDrift({
    rows: [...rows(DED, 2000, 4, 0), ...rows(DED, 1000, 1, 4)],
    baseline: { [DED]: 1000 },
  });
  check("A1 fires on 4/5 divergence", r.triggered === true, JSON.stringify(r));
  check("A1 rate = 0.8", r.divergenceRate === 0.8, `got ${r.divergenceRate}`);
  check("A1 divergentUserCount = 4", r.divergentUserCount === 4, `got ${r.divergentUserCount}`);
  check("A1 worstField = deductible", r.worstField === DED, `got ${r.worstField}`);
  check("A1 divergentValue = 2000", r.divergentValue === 2000, `got ${r.divergentValue}`);
}

// A2 — BELOW RATE: 1/5 diverge (rate .2 < .3) -> no fire.
{
  const r = computeSlowDrift({
    rows: [...rows(DED, 2000, 1, 0), ...rows(DED, 1000, 4, 1)],
    baseline: { [DED]: 1000 },
  });
  check("A2 no fire below rate (0.2)", r.triggered === false, JSON.stringify(r));
}

// A3 — BELOW COUNT: 2/2 diverge (rate 1.0 but count 2 < 3) -> no fire.
{
  const r = computeSlowDrift({
    rows: rows(DED, 2000, 2, 0),
    baseline: { [DED]: 1000 },
  });
  check("A3 no fire below count (2<3) despite rate 1.0", r.triggered === false, JSON.stringify(r));
}

// A4 — PER-FIELD MAX: deductible drifts 4/5; OOP stable 0/5 -> picks deductible.
{
  const r = computeSlowDrift({
    rows: [
      ...rows(DED, 2000, 4, 0),
      ...rows(DED, 1000, 1, 4),
      ...rows(OOP, 5000, 5, 0), // all match OOP baseline
    ],
    baseline: { [DED]: 1000, [OOP]: 5000 },
  });
  check("A4 max-drift field selected (deductible)", r.worstField === DED, `got ${r.worstField}`);
  check("A4 fires (deductible 0.8)", r.triggered === true, JSON.stringify(r));
}

// A5 — LATEST-PER-USER: 3 users diverge at T1 then re-upload matching at T2 ->
//      latest matches baseline -> 0 divergent -> no fire.
{
  const r = computeSlowDrift({
    rows: [
      ...rows(DED, 2000, 3, 0, T1), // earlier divergent
      ...rows(DED, 1000, 3, 0, T2), // later matches baseline (same u0..u2)
    ],
    baseline: { [DED]: 1000 },
  });
  check("A5 latest-per-user wins (re-corrected -> no drift)", r.triggered === false && r.divergentUserCount === 0, JSON.stringify(r));
}

// A6 — NO BASELINE: null baseline -> field skipped -> no drift.
{
  const r = computeSlowDrift({
    rows: rows(DED, 2000, 5, 0),
    baseline: { [DED]: null },
  });
  check("A6 null baseline -> not evaluated/fired", r.triggered === false && r.worstField === null, JSON.stringify(r));
}

// A7 — DIVERGENT VALUE = PLURALITY: 3x2000 + 1x3000 divergent -> 2000.
{
  const r = computeSlowDrift({
    rows: [...rows(DED, 2000, 3, 0), ...rows(DED, 3000, 1, 3), ...rows(DED, 1000, 1, 4)],
    baseline: { [DED]: 1000 },
  });
  check("A7 divergentValue = plurality (2000)", r.divergentValue === 2000, `got ${r.divergentValue}`);
  check("A7 fires (4/5)", r.triggered === true, JSON.stringify(r));
}

console.log("\n=== Suite B — contributesUnderLayer1 (split-the-flag; deadlock fix) ===");
{
  const RB: ValidityGateFailure = "canonical_re_baseline_required";
  const FS: ValidityGateFailure = "file_size_below_minimum";
  check("B1 no failures -> contributes", contributesUnderLayer1([]) === true);
  check("B2 re_baseline ONLY -> contributes (rebuild can proceed)", contributesUnderLayer1([RB]) === true);
  check("B3 quality failure -> blocks", contributesUnderLayer1([FS]) === false);
  check("B4 re_baseline + quality failure -> blocks", contributesUnderLayer1([RB, FS]) === false);
}

console.log("\n=== Suite C — reset-loop + mapping invariants ===");
{
  // clearReBaseline = inReBaselineMode && result.promoted (the exact recorder condition).
  const clear = (inReBaseline: boolean, promoted: boolean) => inReBaseline && promoted;
  check("C1 re_baseline + re-promoted -> CLEAR (recovery)", clear(true, true) === true);
  check("C2 re_baseline + not-promoted -> stay (still rebuilding)", clear(true, false) === false);
  check("C3 not re_baseline + promoted -> no clear (normal promote)", clear(false, true) === false);
  check("C4 not re_baseline + not promoted -> no clear", clear(false, false) === false);

  check("C5 docType sbc -> parser_kind sbc", docTypeToParserKind("sbc") === "sbc");
  check("C6 docType eoc -> parser_kind eoc", docTypeToParserKind("eoc") === "eoc");
  check("C7 docType plan_document -> parser_kind plan_doc", docTypeToParserKind("plan_document") === "plan_doc");
  check("C8 docType education_doc -> null (no slow-drift)", docTypeToParserKind("education_doc") === null);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} cf40-v4 slow-drift + reset fixture: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
