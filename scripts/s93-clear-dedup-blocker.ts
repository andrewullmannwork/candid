/**
 * S93 — clear dedup blocker for andrew@ Cigna SBC re-test.
 *
 * Doc 42a8061c (file_hash 91f425a6...) from 2026-05-08 is causing the
 * /api/documents/upload dedup check at upload/route.ts:214-233 to short-circuit
 * Andrew's re-upload of current_cigna_plan.pdf, which prevented Stage 3
 * unified plan_doc dispatch routing from being exercised.
 *
 * Per Pattern 1 #10 (no hard deletes): soft-delete by setting status='error'
 * with audit-tracking processing_step + processing_error. This removes the
 * doc from the dedup whitelist (`status in [queued, processing, processed]`)
 * without losing the row.
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "../.env.local"), override: true });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
async function main() {
  const docId = "42a8061c-25f9-4224-aedc-787ccfc5a6ce";

  // Show current state
  const { data: before } = await sb
    .from("documents")
    .select("id, file_name, status, processing_step, file_hash, created_at")
    .eq("id", docId)
    .maybeSingle();
  console.log("BEFORE:");
  console.log(JSON.stringify(before, null, 2));

  // Soft-delete: status=error + tracking processing_step
  const { error } = await sb
    .from("documents")
    .update({
      status: "error",
      processing_step: "soft_deleted_s93_stage3_dedup_test",
      processing_error:
        "S93 — soft-deleted to allow re-parse of current_cigna_plan.pdf for Stage 3 unified dispatch validation. Per Pattern 1 #10, no hard delete; row preserved for audit. Insurance plans + canonical mappings linked to this doc are unchanged.",
    })
    .eq("id", docId);
  if (error) {
    console.log("ERR:", error);
    process.exit(1);
  }

  // Verify
  const { data: after } = await sb
    .from("documents")
    .select("id, file_name, status, processing_step, file_hash, created_at")
    .eq("id", docId)
    .maybeSingle();
  console.log("\nAFTER:");
  console.log(JSON.stringify(after, null, 2));

  // Confirm dedup query no longer matches
  const userUuid = "2ce55772-bdf1-4edd-bd16-215aa239990e";
  const { data: dedupCheck } = await sb
    .from("documents")
    .select("id, status, file_name, created_at")
    .eq("user_id", userUuid)
    .eq("file_hash", before?.file_hash || "")
    .in("status", ["queued", "processing", "processed"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  console.log("\nDedup query result for this hash + user (should be null):");
  console.log(JSON.stringify(dedupCheck, null, 2));
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
