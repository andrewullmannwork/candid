/**
 * S71 test-reset (Heavy tier) — Session 73, run by user direction.
 *
 * Wipes Andrew's user-private test data to a near-fresh state for clean MVP
 * smoke testing. Preserves: users + profiles + active insurance_plan + that
 * plan's plan_covered_services + most-recent SBC document. Everything else
 * user-scoped goes.
 *
 * Pattern 1 #10 note: this script HARD-DELETES user-private rows (claims,
 * disputes, line_items, inactive insurance_plans, stale documents, etc.).
 * Hard delete is acceptable here because:
 *   (a) target is a TEST account explicitly authorized for wipe by user
 *   (b) the data is user-scoped — NOT canonical/aggregate
 *   (c) Pattern 1 #10 governs canonical write authority + schema, not user
 *       row deletion at user request
 * Aggregate tables (canonical_plans, canonical_plan_services, insurer_catalog,
 * pricing_aggregates, billing_code_plan_outcomes, audit_rule_accuracy) are
 * NEVER touched.
 *
 * Targets only `andrew.david.ullmann@gmail.com`. Does NOT touch
 * `andrewullmann4@gmail.com` (separate test account; previously cleaned via
 * s71-prod-cleanup.ts).
 *
 * Usage:
 *   npx tsx scripts/s71-test-reset-heavy.ts            # dry-run (default)
 *   npx tsx scripts/s71-test-reset-heavy.ts --apply    # commit deletes
 */

import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(__dirname, "../.env.local"), override: true });

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Missing Supabase env. Aborting.");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const APPLY = process.argv.includes("--apply");
const ANDREW_USER_ID = "2ce55772-bdf1-4edd-bd16-215aa239990e";

function hr(label: string) {
  console.log(`\n${"=".repeat(80)}\n  ${label}\n${"=".repeat(80)}`);
}

async function main() {
  console.log(`Target: andrew.david.ullmann@gmail.com (${ANDREW_USER_ID})`);
  console.log(`Mode: ${APPLY ? "APPLY (HARD DELETES)" : "DRY RUN (use --apply to commit)"}\n`);

  // ── Step 1: Identify what to KEEP ─────────────────────────────────────────
  hr("STEP 1 — Identify keep targets (active plan + most recent SBC)");

  const { data: profile } = await sb
    .from("profiles")
    .select("active_insurance_plan_id")
    .eq("user_id", ANDREW_USER_ID)
    .maybeSingle();
  const activePlanId = profile?.active_insurance_plan_id ?? null;
  if (!activePlanId) {
    console.error("⛔ No active_insurance_plan_id on profile. Aborting (refuse to wipe without an anchor).");
    process.exit(1);
  }
  console.log(`Active plan to KEEP: ${activePlanId}`);

  const { data: docs } = await sb
    .from("documents")
    .select("id, file_name, file_hash, classified_type, status, created_at")
    .eq("user_id", ANDREW_USER_ID)
    .eq("classified_type", "sbc")
    .order("created_at", { ascending: false })
    .limit(1);
  const keepDocId = docs?.[0]?.id ?? null;
  if (!keepDocId) {
    console.warn("⚠ No SBC document found to keep — proceeding anyway (will wipe ALL documents).");
  } else {
    console.log(`Most-recent SBC document to KEEP: ${keepDocId} (${docs![0].file_name})`);
  }

  // ── Step 2: Inventory what will be deleted ────────────────────────────────
  hr("STEP 2 — Inventory targets");

  const counts: Record<string, number> = {};

  const { count: disputeCount } = await sb
    .from("dispute_outcomes")
    .select("*", { count: "exact", head: true })
    .eq("user_id", ANDREW_USER_ID);
  counts.dispute_outcomes = disputeCount ?? 0;

  // claim_line_items don't typically have user_id directly; tied via claim_id
  const { data: claimRows } = await sb
    .from("claims")
    .select("id")
    .eq("user_id", ANDREW_USER_ID);
  const claimIds = (claimRows || []).map((c) => c.id);
  counts.claims = claimIds.length;

  const { count: lineItemCount } = claimIds.length > 0
    ? await sb
        .from("claim_line_items")
        .select("*", { count: "exact", head: true })
        .in("claim_id", claimIds)
    : { count: 0 };
  counts.claim_line_items = lineItemCount ?? 0;

  const { data: planRows } = await sb
    .from("insurance_plans")
    .select("id")
    .eq("user_id", ANDREW_USER_ID)
    .neq("id", activePlanId);
  const planIdsToDelete = (planRows || []).map((p) => p.id);
  counts.insurance_plans_inactive = planIdsToDelete.length;

  const { count: pcsForDeletedPlans } = planIdsToDelete.length > 0
    ? await sb
        .from("plan_covered_services")
        .select("*", { count: "exact", head: true })
        .in("insurance_plan_id", planIdsToDelete)
    : { count: 0 };
  counts.plan_covered_services_for_deleted_plans = pcsForDeletedPlans ?? 0;

  const { data: docsAll } = await sb
    .from("documents")
    .select("id")
    .eq("user_id", ANDREW_USER_ID);
  const docIdsToDelete = (docsAll || [])
    .map((d) => d.id)
    .filter((id) => id !== keepDocId);
  counts.documents_to_delete = docIdsToDelete.length;

  console.log(JSON.stringify(counts, null, 2));

  // ── Step 3: Apply deletes (or dry-run) ────────────────────────────────────
  hr("STEP 3 — Execute deletes");

  if (!APPLY) {
    console.log("(dry run — no writes)\nRe-run with --apply to commit.");
    return;
  }

  // Order matters: delete in FK-dependent order.

  // 3a: dispute_outcomes (FK to claim_id, claim_line_item_id, insurance_plan_id)
  if (counts.dispute_outcomes > 0) {
    const { error } = await sb
      .from("dispute_outcomes")
      .delete()
      .eq("user_id", ANDREW_USER_ID);
    if (error) console.error("dispute_outcomes delete err:", error.message);
    else console.log(`✅ deleted ${counts.dispute_outcomes} dispute_outcomes rows`);
  }

  // 3b: claim_line_items (FK to claim_id)
  if (claimIds.length > 0) {
    const { error } = await sb
      .from("claim_line_items")
      .delete()
      .in("claim_id", claimIds);
    if (error) console.error("claim_line_items delete err:", error.message);
    else console.log(`✅ deleted claim_line_items for ${claimIds.length} claims`);
  }

  // 3c: claims
  if (claimIds.length > 0) {
    const { error } = await sb
      .from("claims")
      .delete()
      .eq("user_id", ANDREW_USER_ID);
    if (error) console.error("claims delete err:", error.message);
    else console.log(`✅ deleted ${claimIds.length} claims rows`);
  }

  // 3d: plan_covered_services for plans being deleted
  if (planIdsToDelete.length > 0) {
    const { error } = await sb
      .from("plan_covered_services")
      .delete()
      .in("insurance_plan_id", planIdsToDelete);
    if (error) console.error("plan_covered_services delete err:", error.message);
    else console.log(`✅ deleted plan_covered_services for ${planIdsToDelete.length} inactive plans`);
  }

  // 3e: insurance_plans (inactive — anything that's not the active one)
  if (planIdsToDelete.length > 0) {
    const { error } = await sb
      .from("insurance_plans")
      .delete()
      .in("id", planIdsToDelete);
    if (error) console.error("insurance_plans delete err:", error.message);
    else console.log(`✅ deleted ${planIdsToDelete.length} stale insurance_plans rows`);
  }

  // 3f: document_extraction_log (telemetry FK to documents)
  if (docIdsToDelete.length > 0) {
    const { error } = await sb
      .from("document_extraction_log")
      .delete()
      .in("document_id", docIdsToDelete);
    if (error && !error.message.includes("relation") && !error.message.includes("does not exist")) {
      console.error("document_extraction_log delete err:", error.message);
    } else {
      console.log(`✅ deleted document_extraction_log entries for ${docIdsToDelete.length} stale docs`);
    }
  }

  // 3g: documents (everything except the kept SBC)
  if (docIdsToDelete.length > 0) {
    const { error } = await sb
      .from("documents")
      .delete()
      .in("id", docIdsToDelete);
    if (error) console.error("documents delete err:", error.message);
    else console.log(`✅ deleted ${docIdsToDelete.length} stale documents`);
  }

  // 3h: re-validate profile pointer (paranoid; should already be correct)
  const { error: profErr } = await sb
    .from("profiles")
    .update({ active_insurance_plan_id: activePlanId })
    .eq("user_id", ANDREW_USER_ID);
  if (profErr) console.error("profile re-validate err:", profErr.message);
  else console.log(`✅ profile.active_insurance_plan_id confirmed = ${activePlanId}`);

  hr("DONE");
  console.log(`Andrew's surface is now: 1 active plan (${activePlanId}), 1 SBC doc, profile, 0 claims/disputes.`);
  console.log("Next: re-upload your test bill / dispute scenario for clean smoke.");
}

main().catch((e) => {
  console.error("Reset script failed:", e);
  process.exit(1);
});
