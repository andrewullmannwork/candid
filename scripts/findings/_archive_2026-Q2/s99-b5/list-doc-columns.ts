import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
async function main() {
  // Try to UPDATE a non-existent doc with metadata to see what error we get
  const { data: tryUpdate, error } = await supabase
    .from("documents")
    .update({ metadata: { test: 1 } })
    .eq("id", "00000000-0000-0000-0000-000000000000")
    .select();
  console.log("update with metadata test:");
  console.log("  data:", tryUpdate);
  console.log("  error:", error);
}
main();
