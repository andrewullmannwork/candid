import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
async function main() {
  const { data } = await supabase
    .from("documents")
    .select("id, file_name, doc_type, classified_type, classification_confidence, status, processing_step, processing_error, metadata, created_at, updated_at")
    .order("created_at", { ascending: false })
    .limit(3);
  for (const d of data ?? []) {
    console.log("---");
    console.log(`id=${d.id.slice(0,8)} file=${d.file_name}`);
    console.log(`  created=${d.created_at} updated=${d.updated_at}`);
    console.log(`  doc_type=${d.doc_type} classified=${d.classified_type} conf=${d.classification_confidence}`);
    console.log(`  status=${d.status} step=${d.processing_step}`);
    console.log(`  error=${d.processing_error ?? "-"}`);
    const m = d.metadata as Record<string, unknown> | null;
    if (m?.doc_type_confirmation) console.log(`  confirmation: ${JSON.stringify(m.doc_type_confirmation)}`);
    if (m?.doc_type_confirmation_result) console.log(`  confirmation_result: ${JSON.stringify(m.doc_type_confirmation_result)}`);
    if (m?.classification_override) console.log(`  override: ${JSON.stringify(m.classification_override)}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
