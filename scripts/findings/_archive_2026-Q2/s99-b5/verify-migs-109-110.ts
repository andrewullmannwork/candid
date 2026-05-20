/**
 * Verify migs 109 + 110 landed: write to documents.metadata + set status to
 * each of the new enum values. Cleans up after itself.
 */
import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
import { randomUUID } from "node:crypto";
loadEnv({ path: ".env.local" });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function main() {
  // Use the hung doc as our test row (it's already status='error' from cancel-hung-doc.ts)
  const HUNG_DOC = "2242cf14-1fb5-44bc-ba4e-e2867ff3894f";

  console.log("Test 1: documents.metadata column writable");
  const { error: e1 } = await supabase
    .from("documents")
    .update({ metadata: { s99b5_mig109_smoke: { ok: true, at: new Date().toISOString() } } })
    .eq("id", HUNG_DOC);
  if (e1) {
    console.log(`  ❌ mig 109 verification FAILED: ${e1.message}`);
    process.exit(1);
  }
  console.log("  ✅ metadata write succeeded");

  console.log("\nTest 2: doc_status enum has 'awaiting_user_confirmation'");
  const { error: e2 } = await supabase
    .from("documents")
    .update({ status: "awaiting_user_confirmation" })
    .eq("id", HUNG_DOC);
  if (e2) {
    console.log(`  ❌ mig 110 (awaiting_user_confirmation) FAILED: ${e2.message}`);
    console.log(`     Schema cache may need refresh — wait 30s and re-run.`);
    process.exit(1);
  }
  console.log("  ✅ status='awaiting_user_confirmation' accepted");

  console.log("\nTest 3: doc_status enum has 'cancelled'");
  const { error: e3 } = await supabase
    .from("documents")
    .update({ status: "cancelled" })
    .eq("id", HUNG_DOC);
  if (e3) {
    console.log(`  ❌ mig 110 (cancelled) FAILED: ${e3.message}`);
    process.exit(1);
  }
  console.log("  ✅ status='cancelled' accepted");

  console.log("\nRestoring hung doc to status='error' for cleanliness...");
  await supabase
    .from("documents")
    .update({
      status: "error",
      metadata: {},
    })
    .eq("id", HUNG_DOC);
  console.log("  ✅ restored");

  console.log("\n✅ All migs verified. Ready for B5 smoke.");
}

main();
