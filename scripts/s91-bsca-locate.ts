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
  const { data: docs } = await sb
    .from("documents")
    .select("id,doc_type,status,processing_step,file_hash,file_name,created_at")
    .like("file_hash", "4692087b%")
    .order("created_at", { ascending: false });
  console.log("Docs with file_hash like 4692087b:");
  console.log(JSON.stringify(docs, null, 2));
}
main().catch(console.error);
