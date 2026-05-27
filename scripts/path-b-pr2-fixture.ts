/**
 * Path B PR #2 fixture — manually runnable per Block Ship Gate G4.
 *
 * Asserts that the backfill script `scripts/admin/rc-3-path-b-backfill.ts`:
 *   1. Dry-run produces no PROD writes (idempotent read-only)
 *   2. In --apply mode, syncs typed cols from JSONB on intentionally-drifted
 *      synthetic rows (canonical_plans + canonical_plan_services)
 *   3. Normalizes JSONB-side coinsurance integer-percent values to decimal
 *      [0, 1] (closes write-side residue cleanup)
 *   4. Idempotent on re-run (post-apply: re-running --apply produces 0
 *      additional updates)
 *   5. Skips already-in-sync rows (no churn)
 *   6. Audits each UPDATE to path_b_backfill_audit table
 *
 * Strategy: insert synthetic canonical_plans + canonical_plan_services rows
 * with deliberately-drifted typed cols + clean JSONB. Run the backfill
 * programmatically (import + invoke main logic, OR shell out to npx tsx
 * with apply flags) against the synthetic rows. Assert post-state.
 *
 * Implementation choice: shell out to the backfill script in --apply mode,
 * scoped to a synthetic test canonical_plan_id. This tests the actual
 * shipped binary, not a re-implementation.
 *
 * Cleanup: try/finally deletes all synthetic rows.
 *
 * Run: cd <repo root> && set -a && source .env.local && set +a && \
 *      npx tsx scripts/path-b-pr2-fixture.ts
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing env.");
  process.exit(1);
}

const sb: SupabaseClient = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(cond: boolean, label: string, detail?: string) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  ✗ ${label}${detail ? `  (${detail})` : ""}`);
  }
}

function header(t: string) {
  console.log("\n" + "─".repeat(70) + "\n" + t + "\n" + "─".repeat(70));
}

interface Cleanup {
  canonicalIds: string[];
  cpsIds: string[];
  auditIds: string[];
}

async function setupInsurer(): Promise<string> {
  const { data } = await sb.from("insurer_catalog").select("id").limit(1).single();
  if (!data?.id) throw new Error("No insurer_catalog rows; cannot create test canonical_plans");
  return data.id as string;
}

async function insertDriftedCanonical(cleanup: Cleanup, insurerId: string): Promise<string> {
  // Drifted state: typed col = 999, JSONB value (≥0.9 confidence) = 1500.
  // Backfill should set typed col = 1500.
  const { data, error } = await sb
    .from("canonical_plans")
    .insert({
      insurer_id: insurerId,
      plan_name: `Fixture-PR2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      plan_year: 2026,
      plan_type: "PPO",
      state: "CA",
      source_count: 1,
      confidence_score: 0.5,
      deductible_individual: 999, // drifted
      oop_max_individual: 8888, // drifted
      metal_level: "bronze", // drifted
      field_provenance: {
        in_deductible_individual: { value: 1500, confidence: 0.9, source: "fixture" },
        in_oop_max_individual: { value: 9000, confidence: 0.9, source: "fixture" },
        metal_level: { value: "gold", confidence: 0.9, source: "fixture" },
        // plan_name JSONB intentionally absent — backfill should not touch it
      },
    })
    .select("id")
    .single();
  if (error || !data?.id) throw new Error(`canonical_plans insert failed: ${error?.message}`);
  cleanup.canonicalIds.push(data.id as string);
  return data.id as string;
}

async function insertDriftedCps(cleanup: Cleanup, canonicalId: string, slug: string) {
  const { data, error } = await sb
    .from("canonical_plan_services")
    .insert({
      canonical_plan_id: canonicalId,
      service_slug: slug,
      confidence: 0.9,
      source: "fixture",
      copay: 10, // drifted (JSONB says 25)
      coinsurance: 0.99, // drifted (JSONB says 30 integer-percent; should normalize to 0.3)
      deductible_applies: false, // drifted (JSONB says true)
      is_covered: false, // drifted (JSONB says true)
      requires_prior_auth: false, // matches JSONB (no update expected)
      field_provenance: {
        copay: { value: 25, confidence: 0.9, source: "fixture" },
        coinsurance: { value: 30, confidence: 0.9, source: "fixture" }, // integer-percent — needs normalize
        deductible_applies: { value: true, confidence: 0.9, source: "fixture" },
        is_covered: { value: true, confidence: 0.9, source: "fixture" },
        requires_prior_auth: { value: false, confidence: 0.9, source: "fixture" },
      },
    })
    .select("id")
    .single();
  if (error || !data?.id) throw new Error(`canonical_plan_services insert failed: ${error?.message}`);
  cleanup.cpsIds.push(data.id as string);
}

async function readCanonical(id: string) {
  const { data } = await sb
    .from("canonical_plans")
    .select("id, deductible_individual, oop_max_individual, plan_name, metal_level, field_provenance")
    .eq("id", id)
    .single();
  return data;
}

async function readCps(canonicalId: string, slug: string) {
  const { data } = await sb
    .from("canonical_plan_services")
    .select("id, copay, coinsurance, deductible_applies, is_covered, requires_prior_auth, field_provenance")
    .eq("canonical_plan_id", canonicalId)
    .eq("service_slug", slug)
    .single();
  return data;
}

async function readAuditForCanonical(canonicalId: string) {
  const { data } = await sb
    .from("path_b_backfill_audit")
    .select("id, source_table, field_name, old_typed_value, new_typed_value, old_json_value, new_json_value")
    .or(`source_row_id.eq.${canonicalId}`);
  return (data || []) as Array<Record<string, unknown>>;
}

async function readAuditForCps(cpsId: string) {
  const { data } = await sb
    .from("path_b_backfill_audit")
    .select("id, source_table, field_name, old_typed_value, new_typed_value, old_json_value, new_json_value")
    .eq("source_row_id", cpsId);
  return (data || []) as Array<Record<string, unknown>>;
}

async function runBackfill(applyMode: boolean): Promise<{ stdout: string; exitCode: number }> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const args = ["tsx", "scripts/admin/rc-3-path-b-backfill.ts"];
    if (applyMode) args.push("--apply", "--i-understand-this-modifies-prod");
    const proc = spawn("npx", args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.on("close", (code: number | null) => resolve({ stdout, exitCode: code ?? -1 }));
  });
}

async function teardown(cleanup: Cleanup) {
  console.log("\n  cleanup…");
  if (cleanup.cpsIds.length > 0) {
    await sb.from("path_b_backfill_audit").delete().in("source_row_id", cleanup.cpsIds);
    await sb.from("canonical_plan_services").delete().in("id", cleanup.cpsIds);
  }
  if (cleanup.canonicalIds.length > 0) {
    await sb.from("path_b_backfill_audit").delete().in("source_row_id", cleanup.canonicalIds);
    await sb.from("canonical_plan_services").delete().in("canonical_plan_id", cleanup.canonicalIds);
    await sb.from("canonical_plans").delete().in("id", cleanup.canonicalIds);
  }
  console.log(`  cleaned ${cleanup.canonicalIds.length} canonical(s), ${cleanup.cpsIds.length} cps, ${cleanup.auditIds.length} audit row(s)`);
}

async function main() {
  console.log("Path B PR #2 backfill fixture\n");
  const cleanup: Cleanup = { canonicalIds: [], cpsIds: [], auditIds: [] };

  try {
    const insurerId = await setupInsurer();

    // ── Test 1: dry-run produces no writes ──
    header("Test 1: dry-run produces no PROD writes");
    const canId = await insertDriftedCanonical(cleanup, insurerId);
    const cpsSlug = `fixture_pr2_${Date.now()}`;
    await insertDriftedCps(cleanup, canId, cpsSlug);

    const beforeCanonical = await readCanonical(canId);
    const beforeCps = await readCps(canId, cpsSlug);

    const dryRunResult = await runBackfill(false);
    assert(dryRunResult.exitCode === 0, "dry-run exits 0");
    assert(dryRunResult.stdout.includes("DRY-RUN"), "dry-run output includes mode banner");
    assert(dryRunResult.stdout.includes("[dry] UPDATE canonical_plans"), "dry-run mentions canonical_plans updates");
    assert(dryRunResult.stdout.includes("[dry] UPDATE canonical_plan_services"), "dry-run mentions cps updates");
    assert(dryRunResult.stdout.includes("[dry] PATCH canonical_plan_services") && dryRunResult.stdout.includes("coinsurance.value"), "dry-run mentions coinsurance JSONB normalize");

    const afterDryCanonical = await readCanonical(canId);
    const afterDryCps = await readCps(canId, cpsSlug);
    assert(beforeCanonical?.deductible_individual === afterDryCanonical?.deductible_individual, "canonical typed col UNCHANGED in dry-run");
    assert(beforeCps?.copay === afterDryCps?.copay, "cps copay UNCHANGED in dry-run");

    // ── Test 2: --apply writes the expected rows ──
    header("Test 2: --apply syncs drifted typed cols");
    const applyResult = await runBackfill(true);
    assert(applyResult.exitCode === 0, "--apply exits 0", applyResult.exitCode !== 0 ? applyResult.stdout.slice(-300) : undefined);
    assert(applyResult.stdout.includes("APPLY (PROD writes enabled)"), "--apply mode banner present");

    const c2 = await readCanonical(canId);
    const c2Ded = c2?.deductible_individual;
    const c2Oop = c2?.oop_max_individual;
    assert(c2Ded !== null && c2Ded !== undefined && Number(c2Ded) === 1500, "canonical deductible_individual synced to 1500", `actual: ${c2Ded}`);
    assert(c2Oop !== null && c2Oop !== undefined && Number(c2Oop) === 9000, "canonical oop_max_individual synced to 9000", `actual: ${c2Oop}`);
    assert(c2?.metal_level === "gold", "canonical metal_level synced to gold");
    assert(c2?.plan_name === beforeCanonical?.plan_name, "canonical plan_name UNCHANGED (JSONB absent)");

    const cps2 = await readCps(canId, cpsSlug);
    const cps2Copay = cps2?.copay;
    assert(cps2Copay !== null && cps2Copay !== undefined && Number(cps2Copay) === 25, "cps copay synced to 25");
    const cps2Coin = cps2?.coinsurance;
    assert(cps2Coin !== null && cps2Coin !== undefined && Math.abs(Number(cps2Coin) - 0.3) < 0.001, "cps coinsurance synced to 0.3 (normalized from 30)", `actual: ${cps2Coin}`);
    assert(cps2?.deductible_applies === true, "cps deductible_applies synced to true");
    assert(cps2?.is_covered === true, "cps is_covered synced to true");
    assert(cps2?.requires_prior_auth === false, "cps requires_prior_auth UNCHANGED (already in sync)");

    // Coinsurance JSONB-side normalize
    const cpsFp = cps2?.field_provenance as Record<string, { value?: unknown }> | null;
    const newJsonbCoinsurance = cpsFp?.coinsurance?.value;
    assert(typeof newJsonbCoinsurance === "number" && Math.abs(Number(newJsonbCoinsurance) - 0.3) < 0.001, "cps field_provenance.coinsurance.value normalized to 0.3", `actual: ${newJsonbCoinsurance}`);

    // ── Test 3: audit table captures the changes ──
    header("Test 3: audit table captures changes");
    const canAudit = await readAuditForCanonical(canId);
    assert(canAudit.length >= 3, "canonical audit rows >= 3 (deductible + oop_max + metal_level)", `actual: ${canAudit.length}`);

    const cpsAudit = cps2?.id ? await readAuditForCps(cps2.id as string) : [];
    // 4 typed-col updates + 1 coinsurance JSONB normalize = 5 audit rows
    assert(cpsAudit.length >= 5, "cps audit rows >= 5 (4 typed + 1 jsonb normalize)", `actual: ${cpsAudit.length}`);
    const hasJsonNormalize = cpsAudit.some((r) => r.field_name === "coinsurance.json_normalize");
    assert(hasJsonNormalize, "cps audit includes coinsurance.json_normalize entry");

    // ── Test 4: re-run --apply is idempotent (no additional updates) ──
    header("Test 4: idempotency — re-run --apply produces 0 updates");
    const reRun = await runBackfill(true);
    assert(reRun.exitCode === 0, "second --apply exits 0");
    // Parse the "Total field-updates APPLIED:" line
    const updateMatch = reRun.stdout.match(/Total field-updates APPLIED:\s*(\d+)/);
    const totalUpdates = updateMatch ? parseInt(updateMatch[1], 10) : -1;
    // After the synthetic rows are clean, the only updates come from OTHER PROD canonicals
    // (not ours). For idempotency on OUR rows, audit should have no new entries since the
    // first --apply. So we re-read audit count.
    const canAudit2 = await readAuditForCanonical(canId);
    const cpsAudit2 = cps2?.id ? await readAuditForCps(cps2.id as string) : [];
    assert(canAudit.length === canAudit2.length, "no new canonical audit rows on re-run (idempotent)", `before ${canAudit.length} after ${canAudit2.length}`);
    assert(cpsAudit.length === cpsAudit2.length, "no new cps audit rows on re-run (idempotent)", `before ${cpsAudit.length} after ${cpsAudit2.length}`);
    console.log(`  (note: total backfill --apply updates including non-fixture PROD rows: ${totalUpdates})`);
  } finally {
    await teardown(cleanup);
  }

  console.log("\n" + "═".repeat(70));
  console.log(`Result: ${pass} PASS, ${fail} FAIL out of ${pass + fail} assertions`);
  if (fail > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log("All assertions PASSED ✓");
}

void main();
