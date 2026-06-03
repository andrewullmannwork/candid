/**
 * CF-40 v4 — uploader-resolution regression check (S163).
 *
 * Locks the fix for the S163 defect: the v4 recorder (process-plan.ts) and
 * smart-skip (extraction-dedup.ts) resolve the uploader from `documents.user_id`,
 * which is the **users PK** (the upload route writes `user.id`), NOT the
 * `firebase_uid`. The prior `.eq("firebase_uid", doc.user_id)` never matched a
 * UUID → uploader null → the cf40_v4_algorithm flag read OFF (users/percentage
 * targeting needs the email) + trust defaulted to unverified, silently disabling
 * v4 for every parse.
 *
 * This is a READ-ONLY DB check (manually runnable, mirrors the dry-run pattern;
 * not a pure CI fixture because uploader resolution is I/O). PASS asserts, on a
 * real plan-doc upload:
 *   1. resolving by `.eq("id", doc.user_id)` returns a user WITH an email   (the fix)
 *   2. resolving by `.eq("firebase_uid", doc.user_id)` returns NULL          (the bug)
 *
 *   npx tsx scripts/cf40-v4-uploader-resolution-check.ts
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(process.cwd(), ".env.local") });
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
  { auth: { persistSession: false } },
);

const PLAN_DOC_TYPES = ["sbc", "eoc", "plan_document"];

async function main() {
  console.log("\n══ CF-40 v4 uploader-resolution check (READ-ONLY) ══\n");

  const { data: docs, error } = await sb
    .from("documents")
    .select("id, user_id, classified_type, created_at")
    .in("classified_type", PLAN_DOC_TYPES)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`documents query: ${error.message}`);
  const doc = docs?.[0];
  if (!doc) {
    console.log("⚠️  no plan-doc uploads found — cannot run the check (vacuous).");
    process.exit(0);
  }
  console.log(`newest plan-doc: ${doc.id.slice(0, 8)}… (${doc.classified_type}), user_id=${doc.user_id}`);

  const { data: byId } = await sb.from("users").select("id, email").eq("id", doc.user_id).maybeSingle();
  const { data: byFb } = await sb.from("users").select("id, email").eq("firebase_uid", doc.user_id).maybeSingle();

  const idResolves = !!byId?.email;
  const fbResolvesNull = !byFb;
  console.log(`  resolve by id          → ${byId?.email ?? "(null)"}   ${idResolves ? "✓" : "✗"}`);
  console.log(`  resolve by firebase_uid → ${byFb?.email ?? "(null)"}   ${fbResolvesNull ? "✓ (expected null)" : "✗ (UNEXPECTED match)"}`);

  const pass = idResolves && fbResolvesNull;
  console.log(`\n${pass ? "✅ PASS" : "❌ FAIL"} — documents.user_id resolves as users.id (v4 must resolve uploader by id).\n`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
