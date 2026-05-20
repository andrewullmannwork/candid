import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
async function main() {
  const { data, error } = await supabase
    .from("documents")
    .select("*")
    .eq("id", "2242cf14-1fb5-44bc-ba4e-e2867ff3894f")
    .single();
  if (error) { console.error(error); return; }
  console.log("Available columns + sample values for hung doc:");
  for (const [k, v] of Object.entries(data ?? {})) {
    const valStr = typeof v === "object" ? JSON.stringify(v).slice(0, 300) : String(v);
    console.log(`  ${k}: ${valStr}`);
  }
}
main();
