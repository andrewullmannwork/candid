import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

let lastSig = "";
const start = Date.now();
async function poll() {
  const { data, error } = await supabase
    .from("documents")
    .select("id, file_name, doc_type, classified_type, classification_confidence, status, processing_step, processing_error, metadata, created_at")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error || !data || data.length === 0) { return false; }
  const d = data[0];
  const ageS = ((Date.now() - start) / 1000).toFixed(0);
  const meta = d.metadata as Record<string, unknown> | null;
  const ovrd = meta?.classification_override as Record<string, unknown> | undefined;
  const conf = meta?.doc_type_confirmation as Record<string, unknown> | undefined;
  const sig = `${d.status}|${d.processing_step ?? ""}|${d.classified_type ?? ""}|${d.classification_confidence ?? ""}|${ovrd ? "OVRD" : ""}|${conf ? "CONF" : ""}`;
  if (sig !== lastSig) {
    lastSig = sig;
    console.log(`[+${ageS}s] doc=${d.id.slice(0,8)} file=${d.file_name} doc_type=${d.doc_type} classified=${d.classified_type ?? "-"} conf=${d.classification_confidence ?? "-"} status=${d.status} step=${d.processing_step ?? "-"}`);
    if (ovrd) console.log(`         override: ${JSON.stringify(ovrd)}`);
    if (conf) console.log(`         confirmation: ${JSON.stringify(conf)}`);
    if (d.processing_error) console.log(`         error: ${d.processing_error}`);
  }
  return d.status === "processed" || d.status === "error" || d.status === "cancelled";
}
async function main() {
  const docCreatedSince = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const { data: pre } = await supabase.from("documents").select("created_at").order("created_at", { ascending: false }).limit(1);
  const preLatest = pre?.[0]?.created_at ?? null;
  console.log(`[watch] starting; max 8 min; latest pre-watch doc created_at=${preLatest}`);
  while (Date.now() - start < 8 * 60 * 1000) {
    const done = await poll();
    if (done) { console.log(`[+${((Date.now()-start)/1000).toFixed(0)}s] TERMINAL`); break; }
    await new Promise(r => setTimeout(r, 2000));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
