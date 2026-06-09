/**
 * Phase 1a Step D0 — EOC coverage write-correctness fixture (TS, runnable):
 *   npx tsx scripts/calibration/fixtures/thesaurus-phase1a/eoc-coverage.ts
 *
 * Proves the D0 fix for the live process-eoc no-op (it filtered/inserted the NON-EXISTENT
 * `plan_id`/`service_slug` columns → silent drop of every EOC prior-auth / medical-necessity write):
 *   (1) upsertServiceCoverage filters on the REAL columns (insurance_plan_id + service_id),
 *       never the bug columns (plan_id / service_slug).
 *   (2) It SURFACES prior-auth: sets the typed `prior_auth_required` column (what /plan + /compare
 *       read) on EVERY cell + merges field_provenance (cite-grade) + merges coverage_rules.
 *   (3) Base cell: no cells + allowBaseCell → one (any, global) cell via the 4-col onConflict,
 *       covered=true, source='plan_doc_parsed'.
 *   (4) Medical-necessity-only (allowBaseCell=false, no cells) → 0 writes (no phantom covered row).
 *   (5) resolveServiceIdBySlug maps slug → service_catalog id.
 */
import {
  upsertServiceCoverage,
  resolveServiceIdBySlug,
  PLAN_COVERED_ONCONFLICT,
} from "../../../../src/lib/plan/coverage-targeting";
import type { FieldProvenanceEntry } from "../../../../src/lib/parser/field-categories";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}`); failures++; }
}

const fakeProvEntry: FieldProvenanceEntry = {
  source: "doc_extraction_eoc",
  confidence: 0.5,
  last_corroborated_at: "2026-06-09T00:00:00.000Z",
  source_excerpt: "Prior authorization required for...",
  source_excerpt_verified: "verified",
};

// A mock supabase that records the .eq() filter columns, .update() payloads, and .upsert() calls.
function makeFake(cells: Array<Record<string, unknown>>) {
  const selectEqCols: string[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const upserts: Array<{ rows: unknown; onConflict: string }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fake: any = {
    from() { return this; },
    select() {
      return {
        eq(col1: string) {
          selectEqCols.push(col1);
          return {
            eq(col2: string) {
              selectEqCols.push(col2);
              return Promise.resolve({ data: cells, error: null });
            },
          };
        },
      };
    },
    update(payload: Record<string, unknown>) {
      updates.push(payload);
      return { eq: () => Promise.resolve({ error: null }) };
    },
    upsert(rows: unknown, opts: { onConflict: string }) {
      upserts.push({ rows, onConflict: opts.onConflict });
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { fake, selectEqCols, updates, upserts };
}

async function testExistingCellsSurface(): Promise<void> {
  const cells = [
    { id: "fac", coverage_rules: { keep: 1 }, field_provenance: { covered: { source: "x" } } },
    { id: "pro", coverage_rules: null, field_provenance: null },
  ];
  const { fake, selectEqCols, updates } = makeFake(cells);
  const n = await upsertServiceCoverage(fake, "plan1", "svc1", {
    typed: { prior_auth_required: true },
    coverageRules: { requires_prior_auth: true, prior_auth_criteria: "over $500" },
    provenance: { prior_auth_required: fakeProvEntry },
  }, { allowBaseCell: true });

  check("filters on the REAL columns (insurance_plan_id + service_id), NOT the bug columns",
    selectEqCols.includes("insurance_plan_id") && selectEqCols.includes("service_id") &&
    !selectEqCols.includes("plan_id") && !selectEqCols.includes("service_slug"));
  check("patched BOTH cells (no .maybeSingle throw)", n === 2 && updates.length === 2);
  check("SURFACES prior-auth: sets typed prior_auth_required=true on every cell",
    updates.every((u) => u.prior_auth_required === true));
  check("merges coverage_rules (preserves existing keys)",
    (updates[0].coverage_rules as Record<string, unknown>).keep === 1 &&
    (updates[0].coverage_rules as Record<string, unknown>).requires_prior_auth === true);
  check("merges field_provenance (adds prior_auth_required, preserves existing covered)",
    !!(updates[0].field_provenance as Record<string, unknown>).prior_auth_required &&
    !!(updates[0].field_provenance as Record<string, unknown>).covered);
  check("handles null coverage_rules + field_provenance on the second cell",
    !!(updates[1].coverage_rules as Record<string, unknown>).requires_prior_auth &&
    !!(updates[1].field_provenance as Record<string, unknown>).prior_auth_required);
}

async function testBaseCellCreation(): Promise<void> {
  const { fake, upserts } = makeFake([]); // no existing cells
  const n = await upsertServiceCoverage(fake, "plan2", "svc2", {
    typed: { prior_auth_required: true },
    coverageRules: { requires_prior_auth: true },
    provenance: { prior_auth_required: fakeProvEntry },
  }, { allowBaseCell: true });

  check("creates exactly one base cell", n === 1 && upserts.length === 1);
  check("base cell targets the 4-col onConflict (mig 157)", upserts[0].onConflict === PLAN_COVERED_ONCONFLICT);
  const row = (upserts[0].rows as Array<Record<string, unknown>>)[0];
  check("base cell is (any, global), covered=true, prior_auth_required=true, source=plan_doc_parsed",
    row.place_of_service === "any" && row.component === "global" && row.covered === true &&
    row.prior_auth_required === true && row.source === "plan_doc_parsed");
}

async function testMedicalNecessityNoPhantomCell(): Promise<void> {
  const { fake, upserts, updates } = makeFake([]); // no existing cells
  const n = await upsertServiceCoverage(fake, "plan3", "svc3", {
    coverageRules: { medical_necessity_text: "documented failure of conservative therapy" },
  }, { allowBaseCell: false });
  check("medical-necessity-only (no cells, allowBaseCell=false) → 0 writes, no phantom covered row",
    n === 0 && upserts.length === 0 && updates.length === 0);
}

async function testResolveServiceIdBySlug(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fakeCat: any = {
    from() { return this; },
    select() {
      return {
        eq(_col: string, val: string) {
          return { maybeSingle: () => Promise.resolve({ data: val === "surgery" ? { id: "svc-surgery" } : null, error: null }) };
        },
      };
    },
  };
  check("resolveServiceIdBySlug maps a known slug → id", (await resolveServiceIdBySlug(fakeCat, "surgery")) === "svc-surgery");
  check("resolveServiceIdBySlug returns null for an unknown slug", (await resolveServiceIdBySlug(fakeCat, "nope")) === null);
}

async function main(): Promise<void> {
  await testExistingCellsSurface();
  await testBaseCellCreation();
  await testMedicalNecessityNoPhantomCell();
  await testResolveServiceIdBySlug();
  if (failures > 0) { console.error(`\n✗ EOC-COVERAGE FIXTURE: ${failures} FAILED`); process.exit(1); }
  console.log("\n>>> THESAURUS PHASE-1A STEP-D0 EOC-COVERAGE FIXTURE: PASS <<<");
}
void main();
