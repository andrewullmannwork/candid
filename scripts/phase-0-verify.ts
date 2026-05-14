/**
 * scripts/phase-0-verify.ts — S90 Phase 0 PROD state verification.
 *
 * Read-only. Confirms all pre-S90 actions completed cleanly before any
 * testing starts. Halts (exit 1) on any failure so Phase 1+ never starts
 * against a partially-deployed state.
 *
 * Checks:
 *   1. PROD https://www.candidclaim.com/api/health returns 200.
 *   2. feature_flag_rules state matches Subplan §1.4 expected inventory.
 *   3. Mig 098 confirmation — `billing_code_identity.do_not_surface_in_letters`
 *      column exists (probes column via REST API which fails if column missing).
 *   4. billing_code_identity contains >=55 rows with `admin_seed_pre_launch`
 *      source (Andrew applied admin-bootstrap CLI at S89 close).
 *   5. Spend-cap state for Andrew primary + andrewullmann4. Per PR #72 (`f97a655`)
 *      the durable mechanism is hardcoded SPEND_CAP_BYPASS_EMAILS in
 *      src/lib/haiku-client/spend-guard.ts (NOT the override_cap_usd row).
 *      Reports today's haiku_spend_tracking rows for both accounts.
 *
 * Pre-test snapshot summary (informational, not gating):
 *   - Claims + line items + disputes + active plans for Andrew + andrewullmann4.
 *   - Active plan canonical_plan_id resolutions.
 *   - Andrew runs Supabase Studio export separately (per Subplan §4 Variables).
 *
 * Usage:
 *   npx tsx scripts/phase-0-verify.ts
 */

import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(__dirname, "../.env.local"), override: true });

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE env. Aborting.");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const PROD_URL = "https://www.candidclaim.com";

const ANDREW_PRIMARY_EMAIL = "andrew.david.ullmann@gmail.com";
const ANDREW_SECONDARY_EMAIL = "andrewullmann4@gmail.com";
const ANDREW_SECONDARY_USER_ID = "ac563af7-b6c9-4a98-bb98-86e56d27a945";

// Locked at S90 Phase 0 kickoff after Andrew confirmed drift items.
// "missing_ok" = row may legitimately be absent; functionally OFF.
const EXPECTED_FLAGS: Record<string, "on" | "off" | "missing_ok"> = {
  s74_5_categorization_flywheel_v1: "on",
  plan_doc_parser_v2: "on",
  eoc_parser_v1: "on",
  parse_strategy_v2: "on",
  cf40_v4_algorithm: "off",
  admin_attestation_enabled: "on",
  claims_persistence: "on",
  claims_backflow: "off",
  billing_code_service_mapping: "on",
  phone_otp_enforcement_v1: "on",
  turnstile_enforcement_v1: "on",
  benefits_comparison_v1: "on",
  async_ingestion_ux_v1: "missing_ok",
  dispute_letter_v2: "on",
  dispute_feedback_loop: "on",
  canonical_promotion_event_v1: "on",
};

interface CheckResult {
  name: string;
  status: "PASS" | "FAIL" | "INFO";
  detail: string;
}

const results: CheckResult[] = [];

function hr(label: string) {
  console.log(`\n${"=".repeat(80)}\n  ${label}\n${"=".repeat(80)}`);
}

function sub(label: string) {
  console.log(`\n--- ${label} ---`);
}

async function check1Health(): Promise<void> {
  // No /api/health route in the codebase; per Subplan §0 Phase 0 "or
  // equivalent" — homepage 200 confirms Vercel serving the build.
  hr("CHECK 1 — PROD homepage returns 200");
  try {
    const res = await fetch(`${PROD_URL}/`, {
      headers: { "User-Agent": "phase-0-verify" },
    });
    if (res.status === 200) {
      console.log(`✅ ${PROD_URL}/ → 200`);
      results.push({ name: "PROD homepage 200", status: "PASS", detail: "200 OK" });
    } else {
      console.log(`❌ ${PROD_URL}/ → ${res.status}`);
      results.push({ name: "PROD homepage 200", status: "FAIL", detail: `${res.status}` });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`❌ homepage fetch threw: ${msg}`);
    results.push({ name: "PROD homepage 200", status: "FAIL", detail: msg });
  }
}

async function check2Flags(): Promise<void> {
  hr("CHECK 2 — feature_flag_rules state vs §1.4 expected");
  const { data, error } = await sb
    .from("feature_flag_rules")
    .select("flag_key, enabled, target_type, config")
    .in("flag_key", Object.keys(EXPECTED_FLAGS));
  if (error) {
    console.log(`❌ feature_flag_rules query error: ${error.message}`);
    results.push({
      name: "feature_flag_rules",
      status: "FAIL",
      detail: error.message,
    });
    return;
  }

  const got = new Map<string, { enabled: boolean; target_type: string; config: unknown }>();
  for (const row of data || []) {
    got.set(
      (row as { flag_key: string }).flag_key,
      {
        enabled: (row as { enabled: boolean }).enabled,
        target_type: (row as { target_type: string }).target_type,
        config: (row as { config: unknown }).config,
      },
    );
  }

  let allMatch = true;
  let missingOkCount = 0;
  let missingFailCount = 0;
  console.log(`\n  ${"FLAG".padEnd(40)} ${"EXPECTED".padEnd(12)} ${"ACTUAL".padEnd(10)} ${"TARGET".padEnd(10)} CONFIG`);
  for (const [key, expected] of Object.entries(EXPECTED_FLAGS)) {
    const actual = got.get(key);
    if (!actual) {
      if (expected === "missing_ok" || expected === "off") {
        console.log(`ℹ️ ${key.padEnd(40)} ${expected.padEnd(12)} MISSING    (functionally off)`);
        missingOkCount++;
      } else {
        console.log(`❌ ${key.padEnd(40)} ${expected.padEnd(12)} MISSING`);
        missingFailCount++;
        allMatch = false;
      }
      continue;
    }
    const actualStr = actual.enabled ? "on" : "off";
    const match = expected === "missing_ok" || expected === actualStr;
    const marker = match ? "✅" : "❌";
    if (!match) allMatch = false;
    const configStr = actual.config && Object.keys(actual.config as object).length > 0
      ? JSON.stringify(actual.config)
      : "—";
    console.log(
      `${marker} ${key.padEnd(40)} ${expected.padEnd(12)} ${actualStr.padEnd(10)} ${actual.target_type.padEnd(10)} ${configStr}`,
    );
  }
  console.log(
    `\n  Total: ${Object.keys(EXPECTED_FLAGS).length} | Missing-but-ok: ${missingOkCount} | Missing-fail: ${missingFailCount}`,
  );

  results.push({
    name: "feature_flag_rules",
    status: allMatch ? "PASS" : "FAIL",
    detail: allMatch ? "all expected states present" : `${missingFailCount} missing failures`,
  });
}

async function check3Mig098(): Promise<void> {
  hr("CHECK 3 — Mig 098 confirmation (billing_code_identity.do_not_surface_in_letters)");
  // Probe by selecting the column; if column missing, REST returns 400 with "column ... does not exist"
  const { data, error } = await sb
    .from("billing_code_identity")
    .select("id, do_not_surface_in_letters, promotion_state")
    .limit(3);
  if (error) {
    console.log(`❌ billing_code_identity column probe error: ${error.message}`);
    results.push({
      name: "mig 098 do_not_surface_in_letters column",
      status: "FAIL",
      detail: error.message,
    });
    return;
  }
  console.log(`✅ Column exists. Sample (limit 3):`);
  for (const row of data || []) {
    const r = row as { id: string; do_not_surface_in_letters: boolean; promotion_state: string };
    console.log(`   id=${r.id} do_not_surface=${r.do_not_surface_in_letters} state=${r.promotion_state}`);
  }
  results.push({
    name: "mig 098 column probe",
    status: "PASS",
    detail: `${data?.length || 0} sample rows`,
  });
}

async function check4SeededRows(): Promise<void> {
  hr("CHECK 4 — admin_seed_pre_launch source count >= 55");

  // Use the canonical SQL admin-seed-description-bindings.ts criterion:
  // distinct rows whose corroborator_sources JSONB array contains a source
  // entry tagged admin_seed_pre_launch.
  // PostgREST doesn't support JSONB array-contains-element directly via the
  // SDK without an RPC, so we fetch promotion_state='proposed' rows with the
  // service_slug populated and count those whose corroborator_sources string
  // includes the admin_seed_pre_launch tag.
  const { data, error, count } = await sb
    .from("billing_code_identity")
    .select("id, corroborator_sources, promotion_state, service_slug", { count: "exact" })
    .eq("promotion_state", "proposed")
    .not("service_slug", "is", null);
  if (error) {
    console.log(`❌ billing_code_identity count error: ${error.message}`);
    results.push({
      name: "admin_seed_pre_launch rows",
      status: "FAIL",
      detail: error.message,
    });
    return;
  }
  const adminSeedRows = (data || []).filter((r) => {
    const sources = (r as { corroborator_sources: unknown }).corroborator_sources;
    if (!Array.isArray(sources)) return false;
    return sources.some(
      (s: unknown) => (s as { source?: string })?.source === "admin_seed_pre_launch",
    );
  });
  console.log(
    `  proposed-state rows (with slug): ${data?.length || 0} | of those tagged admin_seed_pre_launch: ${adminSeedRows.length} | Subplan target: >=55`,
  );
  if (adminSeedRows.length >= 55) {
    console.log(`✅ Threshold met.`);
    results.push({
      name: "admin_seed_pre_launch rows",
      status: "PASS",
      detail: `${adminSeedRows.length} / 55+`,
    });
  } else {
    console.log(`❌ Below threshold.`);
    results.push({
      name: "admin_seed_pre_launch rows",
      status: "FAIL",
      detail: `${adminSeedRows.length} < 55`,
    });
  }
  console.log(`\n  Total billing_code_identity rows (any state, exact count): ${count}`);
}

async function check5SpendCap(): Promise<void> {
  hr("CHECK 5 — Spend cap state (Andrew primary + andrewullmann4)");
  console.log(
    `  Note: PR #72 (f97a655) supersedes the override_cap_usd workaround via\n  hardcoded SPEND_CAP_BYPASS_EMAILS in src/lib/haiku-client/spend-guard.ts.\n  Andrew primary is on the bypass list (durable). andrewullmann4 is NOT (used\n  for the Phase 4F.1 cap-trigger test).\n`,
  );

  const todayIso = new Date().toISOString().slice(0, 10);
  sub(`haiku_spend_tracking today (${todayIso})`);
  const { data, error } = await sb
    .from("haiku_spend_tracking")
    .select("user_id, day_iso, total_cost_usd, override_cap_usd, paused_at")
    .eq("day_iso", todayIso);
  if (error) {
    console.log(`❌ haiku_spend_tracking query error: ${error.message}`);
    results.push({
      name: "haiku_spend_tracking probe",
      status: "FAIL",
      detail: error.message,
    });
    return;
  }
  if ((data?.length || 0) === 0) {
    console.log(`  ℹ️  No rows for today (${todayIso}) — expected; gets populated on first Haiku call.`);
  } else {
    for (const row of data || []) {
      const r = row as {
        user_id: string;
        day_iso: string;
        total_cost_usd: number;
        override_cap_usd: number | null;
        paused_at: string | null;
      };
      console.log(
        `   user_id=${r.user_id} total=$${r.total_cost_usd} override=${r.override_cap_usd ?? "—"} paused=${r.paused_at ?? "—"}`,
      );
    }
  }
  results.push({
    name: "haiku_spend_tracking probe",
    status: "INFO",
    detail: `${data?.length || 0} rows today`,
  });
}

async function snapshotSummary(): Promise<void> {
  hr("PRE-TEST SNAPSHOT SUMMARY (informational)");

  // Resolve Andrew's primary user_id via profiles or via auth.users metadata
  const { data: profiles } = await sb
    .from("profiles")
    .select("user_id, plan_name, insurer, active_insurance_plan_id");

  // Get auth.users emails — service-role can access auth schema
  const { data: { users }, error: usersErr } = await sb.auth.admin.listUsers();
  if (usersErr) {
    console.log(`⚠️  auth.admin.listUsers error: ${usersErr.message}`);
  }
  const userByEmail = new Map<string, string>();
  for (const u of users || []) {
    if (u.email) userByEmail.set(u.email.toLowerCase(), u.id);
  }
  const primaryUserId = userByEmail.get(ANDREW_PRIMARY_EMAIL.toLowerCase());
  const secondaryUserId = ANDREW_SECONDARY_USER_ID; // known constant per Subplan §1

  console.log(
    `  Andrew primary user_id: ${primaryUserId ?? "<not found>"}\n  andrewullmann4 user_id: ${secondaryUserId}`,
  );

  for (const [label, uid] of [
    [`Andrew primary (${ANDREW_PRIMARY_EMAIL})`, primaryUserId],
    [`andrewullmann4 (${ANDREW_SECONDARY_EMAIL})`, secondaryUserId],
  ] as Array<[string, string | undefined]>) {
    if (!uid) {
      console.log(`\n  ${label}: user_id not resolved; skipping.`);
      continue;
    }
    sub(`${label}`);

    const [
      { count: claimsCount },
      { count: lineItemsCount },
      { count: disputesCount },
      { data: activePlans },
    ] = await Promise.all([
      sb.from("claims").select("id", { count: "exact", head: true }).eq("user_id", uid).is("deleted_at", null),
      sb.from("claim_line_items").select("id", { count: "exact", head: true }).eq("user_id", uid),
      sb.from("disputes").select("id", { count: "exact", head: true }).eq("user_id", uid),
      sb
        .from("insurance_plans")
        .select("id, plan_name, insurer, plan_year, canonical_plan_id, is_active, source")
        .eq("user_id", uid)
        .eq("is_active", true),
    ]);
    console.log(
      `    claims (not soft-deleted): ${claimsCount} | line_items: ${lineItemsCount} | disputes: ${disputesCount} | active plans: ${activePlans?.length || 0}`,
    );
    for (const p of (activePlans || []) as Array<Record<string, unknown>>) {
      console.log(
        `      plan ${p.id}: ${p.insurer} / ${p.plan_name} / ${p.plan_year} | canonical=${p.canonical_plan_id ?? "—"} | source=${p.source}`,
      );
    }
  }

  // Profiles light
  sub("profiles row count");
  console.log(`    total profiles: ${profiles?.length || 0}`);

  results.push({
    name: "pre-test snapshot summary",
    status: "INFO",
    detail: "see console output",
  });
}

async function main() {
  console.log(`Phase 0 verification — target ${PROD_URL}`);
  console.log(`Date: ${new Date().toISOString()}\n`);
  await check1Health();
  await check2Flags();
  await check3Mig098();
  await check4SeededRows();
  await check5SpendCap();
  await snapshotSummary();

  hr("PHASE 0 RESULTS");
  let failCount = 0;
  for (const r of results) {
    const marker = r.status === "PASS" ? "✅" : r.status === "FAIL" ? "❌" : "ℹ️";
    console.log(`  ${marker} ${r.name.padEnd(40)} ${r.status.padEnd(6)} ${r.detail}`);
    if (r.status === "FAIL") failCount++;
  }
  console.log(`\n  Summary: ${results.length} checks, ${failCount} failures`);
  if (failCount > 0) {
    console.log(`\n❌ Phase 0 HALT — fix failures before proceeding to Phase 1.`);
    process.exit(1);
  }
  console.log(`\n✅ Phase 0 PASS — ready for Phase 1.`);
}

main().catch((e) => {
  console.error("Phase 0 verify crashed:", e);
  process.exit(1);
});
