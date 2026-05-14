// S74.6 §C.4 D3 cohort accuracy unit tests
//
// Tests the pure-function pieces of `accuracy-cohort-loader.ts`:
//   - mapKey() — composite (rule, insurer, slug) keys with rollup form
//   - decideAccuracyAdjustment() — tier math per Subplan §B locks
//   - applyAccuracyAdjustment() — finding mutation by tier
//   - lookupCohort() — slug-keyed lookup with rollup fallback
//
// DB-touching pieces (loadAccuracyCohortMap) are exercised via the
// integration smoke flow — see testing-strategy doc for rationale.
//
// Run: npx tsx scripts/test-d3-cohort-accuracy.ts

import {
  mapKey,
  decideAccuracyAdjustment,
  applyAccuracyAdjustment,
  lookupCohort,
  type CohortStats,
  type AccuracyCohortMap,
} from "../src/lib/audit/accuracy-cohort-loader";
import type { AuditFinding } from "../src/lib/billing/types";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(`  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── mapKey ──────────────────────────────────────────────────────────────

check(
  "mapKey: 3-arg with slug produces canonical key",
  mapKey("zero_cost_share_overcharge", "Cigna", "immunizations") ===
    "zero_cost_share_overcharge||Cigna||immunizations",
);
check(
  "mapKey: 2-arg falls back to '*' slug",
  mapKey("overcharge", "Aetna") === "overcharge||Aetna||*",
);
check(
  "mapKey: explicit null slug → '*' rollup form",
  mapKey("overcharge", "Aetna", null) === "overcharge||Aetna||*",
);
check(
  "mapKey: empty-string slug → '*' rollup form",
  mapKey("overcharge", "Aetna", "") === "overcharge||Aetna||*",
);
check(
  "mapKey: different slug → different key",
  mapKey("overcharge", "Aetna", "pcp_visit") !==
    mapKey("overcharge", "Aetna", "specialist_visit"),
);

// ── decideAccuracyAdjustment (tier math) ────────────────────────────────

function cohort(opts: {
  won: number;
  lost: number;
  settled?: number;
  avg?: number | null;
}): CohortStats {
  const settled = opts.settled ?? 0;
  return {
    winCount: opts.won,
    lossCount: opts.lost,
    settledCount: settled,
    totalDisputes: opts.won + opts.lost + settled,
    avgRecoveredPct: opts.avg ?? null,
  };
}

// Subplan §C.4 acceptance #1: 9-wins/1-loss, n=10 → boost to ≥0.93
{
  const c = cohort({ won: 9, lost: 1 });
  const decision = decideAccuracyAdjustment(0.85, c);
  check(
    "boost tier: 9w/1l (n=10) baseline=0.85 → tier='boost'",
    decision.tier === "boost",
  );
  if (decision.tier === "boost") {
    check(
      "boost tier: win_rate=0.9 → adjusted ≥ 0.93",
      decision.adjustedConfidence >= 0.93,
      `got ${decision.adjustedConfidence}`,
    );
  }
}

// Subplan §C.4 acceptance #2: 3-wins/7-losses, n=10 → informational chip
{
  const c = cohort({ won: 3, lost: 7 });
  const decision = decideAccuracyAdjustment(0.7, c);
  check(
    "informational tier: 3w/7l (n=10) → tier='informational'",
    decision.tier === "informational",
  );
  if (decision.tier === "informational") {
    check(
      "informational chip is non-empty string",
      typeof decision.chip === "string" && decision.chip.length > 0,
    );
  }
}

// Subplan §C.4 acceptance #3: 1-win/9-losses, n=10 → suppressed
{
  const c = cohort({ won: 1, lost: 9 });
  const decision = decideAccuracyAdjustment(0.7, c);
  check(
    "suppress tier: 1w/9l (n=10) → tier='suppress'",
    decision.tier === "suppress",
  );
}

// Subplan §C.4 acceptance #4: empty cohort → baseline
{
  const decision = decideAccuracyAdjustment(0.7, undefined);
  check(
    "baseline tier: undefined cohort → tier='baseline'",
    decision.tier === "baseline",
  );
}

// Boundary: n < BOOST_N_FLOOR (5) → baseline (prevents small-cohort pendulum)
{
  const c = cohort({ won: 4, lost: 0 });
  const decision = decideAccuracyAdjustment(0.7, c);
  check(
    "boundary: n=4 < 5 boost floor → tier='baseline'",
    decision.tier === "baseline",
  );
}

// Boundary: n=5 with high win rate → boost
{
  const c = cohort({ won: 5, lost: 0 });
  const decision = decideAccuracyAdjustment(0.7, c);
  check(
    "boundary: n=5 with 100% wins → tier='boost'",
    decision.tier === "boost",
  );
}

// Boundary: n=5-9 with low win rate → baseline (not suppress yet)
{
  const c = cohort({ won: 0, lost: 6 });
  const decision = decideAccuracyAdjustment(0.7, c);
  check(
    "boundary: n=6 with 0% wins → tier='baseline' (not enough data for suppress)",
    decision.tier === "baseline",
  );
}

// Settled treated as a win (per Subplan §B locked math)
{
  const c = cohort({ won: 5, settled: 4, lost: 1 });
  const decision = decideAccuracyAdjustment(0.8, c);
  check(
    "settled-counts-as-win: 5w+4s/1l (n=10) → tier='boost'",
    decision.tier === "boost",
  );
}

// Confidence clamp: baseline=0.95 + max boost won't exceed 0.95 ceiling
{
  const c = cohort({ won: 10, lost: 0 });
  const decision = decideAccuracyAdjustment(0.95, c);
  if (decision.tier === "boost") {
    check(
      "confidence clamp: ceiling 0.95",
      decision.adjustedConfidence <= 0.95,
      `got ${decision.adjustedConfidence}`,
    );
  } else {
    check("confidence clamp: 100%-win cohort → boost tier", false);
  }
}

// Confidence clamp: baseline=0.40 should clamp UP to floor 0.50
{
  const c = cohort({ won: 5, lost: 5 });
  const decision = decideAccuracyAdjustment(0.4, c);
  if (decision.tier === "boost") {
    check(
      "confidence clamp: floor 0.50 (low baseline preserved)",
      decision.adjustedConfidence >= 0.5,
      `got ${decision.adjustedConfidence}`,
    );
  }
}

// ── applyAccuracyAdjustment ─────────────────────────────────────────────

const baseFinding: AuditFinding = {
  id: "test-finding-1",
  type: "zero_cost_share_overcharge",
  severity: "medium",
  lineItems: [1],
  title: "Test finding",
  description: "Test description",
  estimatedOvercharge: 20.0,
  benchmarkSource: "Internal",
  billedAmount: 20.0,
  confidence: 0.7,
  actionable: true,
};

{
  const result = applyAccuracyAdjustment(baseFinding, { tier: "baseline" });
  check(
    "applyAccuracyAdjustment baseline: returns finding unchanged",
    result === baseFinding,
  );
}

{
  const result = applyAccuracyAdjustment(baseFinding, {
    tier: "boost",
    adjustedConfidence: 0.9,
  });
  check(
    "applyAccuracyAdjustment boost: confidence bumped",
    result != null && result.confidence === 0.9,
  );
  check(
    "applyAccuracyAdjustment boost: other fields preserved",
    result != null && result.id === baseFinding.id,
  );
}

{
  const result = applyAccuracyAdjustment(baseFinding, {
    tier: "informational",
    chip: "Test chip",
  });
  check(
    "applyAccuracyAdjustment informational: chip attached",
    result != null && result.cohortAccuracyChip === "Test chip",
  );
  check(
    "applyAccuracyAdjustment informational: confidence unchanged",
    result != null && result.confidence === 0.7,
  );
}

{
  const result = applyAccuracyAdjustment(baseFinding, { tier: "suppress" });
  check(
    "applyAccuracyAdjustment suppress: returns null",
    result === null,
  );
}

// ── lookupCohort (slug fallback) ────────────────────────────────────────

{
  const map: AccuracyCohortMap = new Map();
  map.set(
    mapKey("overcharge", "Aetna", "pcp_visit"),
    cohort({ won: 5, lost: 5 }),
  );
  map.set(
    mapKey("overcharge", "Aetna", null),
    cohort({ won: 10, lost: 10 }),
  );

  const slugHit = lookupCohort(map, "overcharge", "Aetna", "pcp_visit");
  check(
    "lookupCohort: slug-keyed hit takes priority",
    slugHit?.totalDisputes === 10, // 5+5 = 10
  );

  const slugMiss = lookupCohort(map, "overcharge", "Aetna", "specialist_visit");
  check(
    "lookupCohort: slug miss falls back to rollup",
    slugMiss?.totalDisputes === 20, // 10+10 = 20
  );

  const noSlug = lookupCohort(map, "overcharge", "Aetna", null);
  check(
    "lookupCohort: null slug returns rollup directly",
    noSlug?.totalDisputes === 20,
  );

  const totalMiss = lookupCohort(map, "overcharge", "Cigna", "pcp_visit");
  check(
    "lookupCohort: insurer miss returns undefined",
    totalMiss === undefined,
  );
}

// ── Summary ─────────────────────────────────────────────────────────────

console.log(`[D3 cohort accuracy] ${pass}/${pass + fail} passed`);
if (fail > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(f);
  process.exit(1);
}
