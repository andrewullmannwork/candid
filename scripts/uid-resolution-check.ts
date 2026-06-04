/**
 * S164 — `*.user_id` resolution regression check (the uid/firebase_uid defect class).
 *
 * Locks the S163/S164 fix: every `*.user_id` column (documents/insurance_plans/
 * claims/…) stores the **users PK** (users.id), NOT the firebase_uid. The defect
 * class resolved a user via `.eq("firebase_uid", <a users PK>)` → never matched a
 * UUID → silent null → disabled flag reads / dropped flywheel votes / skipped
 * enqueues. The fix routes every such seam through `getUserContextByPk`
 * (`.eq("id", …)` + a warn-on-null G7 sentinel).
 *
 * READ-ONLY DB check (manually runnable, mirrors cf40-v4-uploader-resolution-check;
 * not a pure CI fixture because resolution is I/O). On a real plan-doc AND a real
 * bill upload, PASS asserts:
 *   1. getUserContextByPk(doc.user_id) returns {id, email} with id === doc.user_id  (the fix)
 *   2. the raw .eq("firebase_uid", doc.user_id) returns NULL                          (the bug)
 *   3. all 7 gating flags are target_type=global → the latent fixes are
 *      behavior-neutral TODAY (resolving the real email can't flip a global flag)
 *
 *   npx tsx scripts/uid-resolution-check.ts
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "path";
import { getUserContextByPk } from "@/lib/users/resolve-user-by-pk";

config({ path: resolve(process.cwd(), ".env.local") });
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
  { auth: { persistSession: false } },
);

const PLAN_DOC_TYPES = ["sbc", "eoc", "plan_document"];
const BILL_TYPES = ["itemized_bill", "eob"];
const GATING_FLAGS = [
  "claims_persistence", "unified_plan_doc_parser_v1", "eoc_parser_v1",
  "document_dedup", "sbc_parser_v1", "canonical_plans", "cf44_selective_self_check",
];

let failed = 0;
function assert(cond: boolean, label: string) {
  console.log(`  ${cond ? "✅" : "❌"} ${label}`);
  if (!cond) failed++;
}

async function checkDoc(kinds: string[], kindLabel: string) {
  const { data: docs } = await sb
    .from("documents")
    .select("id, user_id, classified_type, created_at")
    .in("classified_type", kinds)
    .order("created_at", { ascending: false })
    .limit(1);
  const doc = docs?.[0];
  if (!doc) { console.log(`  ⚠️  no ${kindLabel} upload found — skipping (vacuous)`); return; }
  console.log(`  ${kindLabel}: doc ${doc.id} user_id=${doc.user_id}`);

  const viaHelper = await getUserContextByPk(sb, doc.user_id, `check:${kindLabel}`);
  assert(!!viaHelper, `getUserContextByPk resolves a user`);
  assert(viaHelper?.id === doc.user_id, `resolved id === doc.user_id (PK convention)`);
  assert(viaHelper?.email != null, `resolved row carries an email`);

  const { data: viaFb } = await sb.from("users").select("id").eq("firebase_uid", doc.user_id).maybeSingle();
  assert(viaFb == null, `.eq("firebase_uid", doc.user_id) returns NULL (the bug pattern)`);
}

async function main() {
  console.log("\n══ S164 uid/firebase_uid resolution check (READ-ONLY) ══\n");

  console.log("── plan-doc path ──");
  await checkDoc(PLAN_DOC_TYPES, "plan-doc");
  console.log("\n── bill path ──");
  await checkDoc(BILL_TYPES, "bill");

  console.log("\n── behavior-neutrality: gating flags must be target_type=global ──");
  const { data: flags } = await sb.from("feature_flag_rules").select("flag_key, target_type").in("flag_key", GATING_FLAGS);
  for (const f of flags ?? []) assert(f.target_type === "global", `${f.flag_key} is global (email-independent)`);

  console.log("\n── informational: review-queue attribution (G5) ──");
  for (const t of ["service_catalog_admin_review_queue", "concept_admin_review_queue"]) {
    const { count: total } = await sb.from(t).select("*", { count: "exact", head: true });
    const { count: nullProp } = await sb.from(t).select("*", { count: "exact", head: true }).is("proposed_by_user_id", null);
    console.log(`  ${t}: total=${total} null_proposed_by=${nullProp}`);
  }

  console.log(`\n${failed === 0 ? "✅ PASS" : `❌ FAIL (${failed})`} — uid resolution convention holds\n`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
