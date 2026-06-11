/**
 * Phase 1a Step C — coverage-targeting write-path fixture (TS, runnable):
 *   npx tsx scripts/calibration/fixtures/thesaurus-phase1a/write-path.ts
 *
 * Proves the invariant that makes over-broad coverage writes impossible:
 *   (1) PlanCoverageRow REQUIRES place_of_service + component (compile-time, via @ts-expect-error).
 *   (2) applyPlanCoverageCell ALWAYS targets the 4-col onConflict (never the old 3-col key).
 *   (3) coerceComponent maps to the CHECK vocab (flag-OFF undefined → 'global'; byte-identical).
 *   (4) mergeServiceCoverageRules patches EVERY cell of a service (fixes the post-4-col multi-row
 *       .maybeSingle() throw) and MERGES (never clobbers) existing coverage_rules keys.
 */
import {
  applyPlanCoverageCell,
  mergeServiceCoverageRules,
  coerceComponent,
  PLAN_COVERED_ONCONFLICT,
  type PlanCoverageRow,
} from "../../../../src/lib/plan/coverage-targeting";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}`); failures++; }
}

// (1) Compile-time invariant: a missing-axis row must NOT typecheck. If component were ever made
// optional, the @ts-expect-error would itself error (nothing to suppress) and tsc would fail — so
// this is a live guard, not a comment.
// @ts-expect-error component is required; omitting it is a compile error (the over-broad-write guard).
const missingComponent: PlanCoverageRow = { insurance_plan_id: "p", service_id: "s", place_of_service: "any" };
void missingComponent;

// (3) coerceComponent vocab mapping.
check("coerceComponent(undefined) -> global (flag-OFF default)", coerceComponent(undefined) === "global");
check("coerceComponent(null) -> global", coerceComponent(null) === "global");
check("coerceComponent('facility') -> facility", coerceComponent("facility") === "facility");
check("coerceComponent('PROFESSIONAL') -> professional", coerceComponent("PROFESSIONAL") === "professional");
check("coerceComponent('bogus') -> global", coerceComponent("bogus") === "global");

// (2) the onConflict constant is the 4-col key.
check("PLAN_COVERED_ONCONFLICT is the 4-col key",
  PLAN_COVERED_ONCONFLICT === "insurance_plan_id,service_id,place_of_service,component");

async function testUpsertTargets4Col(): Promise<void> {
  let captured = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fake: any = {
    from() { return this; },
    upsert(...args: unknown[]) {
      captured = (args[1] as { onConflict: string }).onConflict;
      return Promise.resolve({ data: null, error: null });
    },
  };
  await applyPlanCoverageCell(fake, { insurance_plan_id: "p", service_id: "s", place_of_service: "any", component: "global" });
  check("applyPlanCoverageCell targets the 4-col onConflict (no over-broad 3-col write)", captured === PLAN_COVERED_ONCONFLICT);
}

async function testMergePatchesEveryCell(): Promise<void> {
  const updates: Array<{ id: string; rules: Record<string, unknown> }> = [];
  const cells = [
    { id: "fac", coverage_rules: { keep: 1 } },
    { id: "pro", coverage_rules: null },
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fake: any = {
    from() { return this; },
    select() { return { eq: () => ({ eq: () => Promise.resolve({ data: cells, error: null }) }) }; },
    update(patch: { coverage_rules: Record<string, unknown> }) {
      return { eq: (...args: unknown[]) => { updates.push({ id: args[1] as string, rules: patch.coverage_rules }); return Promise.resolve({ error: null }); } };
    },
  };
  const n = await mergeServiceCoverageRules(fake, "plan1", "svc1", { how_to_access: "go-here" });
  check("mergeServiceCoverageRules patched BOTH cells (no .maybeSingle throw)", n === 2 && updates.length === 2);
  check("merge preserved existing coverage_rules keys", updates[0].rules.keep === 1 && updates[0].rules.how_to_access === "go-here");
  check("merge handled null coverage_rules", updates[1].rules.how_to_access === "go-here");
}

async function main(): Promise<void> {
  await testUpsertTargets4Col();
  await testMergePatchesEveryCell();
  if (failures > 0) { console.error(`\n✗ WRITE-PATH FIXTURE: ${failures} FAILED`); process.exit(1); }
  console.log("\n>>> THESAURUS PHASE-1A STEP-C WRITE-PATH FIXTURE: PASS <<<");
}
void main();
