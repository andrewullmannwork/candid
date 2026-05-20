import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "../.env.local"), override: true });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const { data } = await sb
    .from("documents")
    .select("id, status, processing_step, processing_error, processing_total_pages, processing_completed_pages, classification_confidence")
    .eq("id", "8e7bf4dd-1b43-488f-b0c1-48cfc22ab330")
    .single();
  console.log(JSON.stringify(data, null, 2));

  // Also: feature_flag_rules state for the relevant flags
  const { data: flags } = await sb
    .from("feature_flag_rules")
    .select("flag_key, target_type, config")
    .in("flag_key", ["doc_type_override_v1", "classifier_haiku_regex_fallback_v1"]);
  console.log("\n=== Flag state ===");
  flags?.forEach((f: any) => console.log(`${f.flag_key}: ${JSON.stringify(f.config)}`));
}

main().catch(e => { console.error(e); process.exit(1); });
