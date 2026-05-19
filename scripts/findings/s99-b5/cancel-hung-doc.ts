/**
 * Cancel the hung document (doc id 2242cf14-1fb5-44bc-ba4e-e2867ff3894f)
 * that was stuck at status='uploaded' due to the documents.metadata column
 * not existing (pre-mig-109 silent-rejection bug).
 *
 * Sets status='cancelled', processing_step='cancelled_due_to_schema_bug',
 * processing_error with explanation. Doc stays in DB (no hard delete per
 * Pattern 1 #10 spirit; user can re-upload after mig 109 lands).
 */
import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const HUNG_DOC_ID = "2242cf14-1fb5-44bc-ba4e-e2867ff3894f";

async function main() {
  // Pre-check: confirm the doc is still in the stuck state we expect
  const { data: before, error: beforeErr } = await supabase
    .from("documents")
    .select("id, status, processing_step, file_name")
    .eq("id", HUNG_DOC_ID)
    .single();
  if (beforeErr || !before) {
    console.error(`Doc ${HUNG_DOC_ID} not found:`, beforeErr?.message);
    process.exit(1);
  }
  console.log(`Pre-cancel state: status=${before.status} step=${before.processing_step ?? "null"} file=${before.file_name}`);

  if (before.status === "error") {
    console.log("Already in error state. Nothing to do.");
    process.exit(0);
  }

  // doc_status enum doesn't have 'cancelled' yet (mig 110 will add it).
  // Use 'error' for the cleanup since it's a valid existing enum value.
  const { error } = await supabase
    .from("documents")
    .update({
      status: "error",
      processing_step: "cancelled_due_to_schema_bug",
      processing_error:
        "Upload halted by B5 doc-type confirmation flow, but the metadata UPDATE + status enum write failed silently due to pre-mig-109/110 schema bugs (documents.metadata column did not exist AND doc_status enum was missing 'awaiting_user_confirmation'/'cancelled' values). Please re-upload after migs 109+110 are applied to PROD.",
    })
    .eq("id", HUNG_DOC_ID);

  if (error) {
    console.error("Update failed:", error.message);
    process.exit(1);
  }

  // Verify
  const { data: after } = await supabase
    .from("documents")
    .select("status, processing_step, processing_error")
    .eq("id", HUNG_DOC_ID)
    .single();
  console.log(`Post-cancel state: status=${after?.status} step=${after?.processing_step}`);
  console.log(`processing_error: ${after?.processing_error}`);
}

main();
