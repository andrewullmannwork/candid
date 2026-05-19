import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
async function main() {
  const { data: stuck, error } = await supabase
    .from("documents")
    .select("id, file_name, status, processing_step, created_at")
    .eq("status", "awaiting_user_confirmation")
    .order("created_at", { ascending: false });
  if (error) { console.error(error); return; }
  console.log(`Found ${stuck?.length ?? 0} docs at awaiting_user_confirmation:`);
  for (const d of stuck ?? []) {
    console.log(`  ${d.id} ${d.file_name} (${new Date(d.created_at).toISOString()})`);
  }
  if (!stuck || stuck.length === 0) return;
  const ids = stuck.map((d) => d.id);
  const { error: updErr } = await supabase
    .from("documents")
    .update({
      status: "cancelled",
      processing_step: "cancelled_by_s99_closeout",
      processing_error: "S99 B5 closeout — frontend modal-render bug not fully resolved this session; doc orphaned at awaiting_user_confirmation. Cancelled at session close so the docs don't sit indefinitely. Will be re-tested next session after audit + fix.",
    })
    .in("id", ids);
  if (updErr) { console.error("update error:", updErr); return; }
  console.log(`\nCancelled ${ids.length} orphan doc(s).`);
}
main();
