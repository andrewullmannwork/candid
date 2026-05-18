import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "../.env.local"), override: true });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
(async () => {
  const { data: flags } = await sb
    .from("feature_flag_rules")
    .select("flag_key,enabled,target_type,target_users,target_percentage,description")
    .in("flag_key", ["async_ingestion_ux_v1", "pdfjs_primary_v1", "ocr_reflow_v1", "unified_plan_doc_parser_v1"]);
  console.log(JSON.stringify(flags, null, 2));
})();
