/**
 * S71 test-reset Heavy fixup — handles FK cycle that blocked the first run.
 *
 * Original s71-test-reset-heavy.ts hit:
 *   documents.linked_insurance_plan_id → insurance_plans.id  (FK)
 *   insurance_plans.source_document_id → documents.id        (FK)
 * Couldn't delete either side without nulling the cross-references first.
 *
 * This fixup:
 *   1. NULL out insurance_plans.source_document_id on stale plans
 *   2. NULL out documents.linked_insurance_plan_id on stale documents
 *   3. Delete stale documents
 *   4. Delete stale insurance_plans
 *
 * Same target + safety semantics as the original script. Dry-run by default.
 */

import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(__dirname, "../.env.local"), override: true });

import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const APPLY = process.argv.includes("--apply");
const ANDREW = "2ce55772-bdf1-4edd-bd16-215aa239990e";

function hr(label: string) {
  console.log(`\n${"=".repeat(80)}\n  ${label}\n${"=".repeat(80)}`);
}

async function main() {
  console.log(`Mode: ${APPLY ? "APPLY (FK nulls + DELETES)" : "DRY RUN"}\n`);

  hr("Discovery");

  const { data: profile } = await sb
    .from("profiles")
    .select("active_insurance_plan_id")
    .eq("user_id", ANDREW)
    .maybeSingle();
  const activePlanId = profile?.active_insurance_plan_id;
  if (!activePlanId) {
    console.error("⛔ No active plan id on profile. Aborting.");
    process.exit(1);
  }
  console.log(`active plan to KEEP: ${activePlanId}`);

  const { data: latestSbc } = await sb
    .from("documents")
    .select("id, file_name, created_at")
    .eq("user_id", ANDREW)
    .eq("classified_type", "sbc")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const keepDocId = latestSbc?.id;
  if (!keepDocId) {
    console.error("⛔ No SBC document found. Aborting.");
    process.exit(1);
  }
  console.log(`keeper SBC document: ${keepDocId} (${latestSbc!.file_name})`);

  const { data: stalePlans } = await sb
    .from("insurance_plans")
    .select("id, source_document_id")
    .eq("user_id", ANDREW)
    .neq("id", activePlanId);
  const stalePlanIds = (stalePlans || []).map((p) => p.id);

  const { data: staleDocs } = await sb
    .from("documents")
    .select("id, linked_insurance_plan_id")
    .eq("user_id", ANDREW)
    .neq("id", keepDocId);
  const staleDocIds = (staleDocs || []).map((d) => d.id);

  console.log(`stale plans to delete: ${stalePlanIds.length}`);
  console.log(`stale documents to delete: ${staleDocIds.length}`);

  if (!APPLY) {
    hr("DRY RUN — no writes");
    console.log("Re-run with --apply to commit.");
    return;
  }

  hr("Step 1 — NULL out FK cross-references");

  // insurance_plans.source_document_id → documents.id
  // Null only on stale plans (active plan keeps its source_document_id)
  if (stalePlanIds.length > 0) {
    const { error } = await sb
      .from("insurance_plans")
      .update({ source_document_id: null })
      .in("id", stalePlanIds);
    if (error) console.error("nulling source_document_id err:", error.message);
    else console.log(`✅ nulled source_document_id on ${stalePlanIds.length} stale plans`);
  }

  // documents.linked_insurance_plan_id → insurance_plans.id
  // Null only on stale docs (keeper SBC keeps its linked_insurance_plan_id)
  if (staleDocIds.length > 0) {
    const { error } = await sb
      .from("documents")
      .update({ linked_insurance_plan_id: null })
      .in("id", staleDocIds);
    if (error) console.error("nulling linked_insurance_plan_id err:", error.message);
    else console.log(`✅ nulled linked_insurance_plan_id on ${staleDocIds.length} stale docs`);
  }

  hr("Step 2 — Delete stale documents");

  if (staleDocIds.length > 0) {
    // Best-effort cleanup of document_extraction_log first (might not exist)
    const { error: logErr } = await sb
      .from("document_extraction_log")
      .delete()
      .in("document_id", staleDocIds);
    if (logErr && !logErr.message.includes("does not exist") && !logErr.message.includes("relation")) {
      console.warn("document_extraction_log cleanup:", logErr.message);
    }

    const { error } = await sb
      .from("documents")
      .delete()
      .in("id", staleDocIds);
    if (error) console.error("documents delete err:", error.message);
    else console.log(`✅ deleted ${staleDocIds.length} stale documents`);
  }

  hr("Step 3 — Delete stale insurance_plans");

  if (stalePlanIds.length > 0) {
    const { error } = await sb
      .from("insurance_plans")
      .delete()
      .in("id", stalePlanIds);
    if (error) console.error("insurance_plans delete err:", error.message);
    else console.log(`✅ deleted ${stalePlanIds.length} stale insurance_plans`);
  }

  hr("DONE");
}

main().catch((e) => {
  console.error("Fixup failed:", e);
  process.exit(1);
});
