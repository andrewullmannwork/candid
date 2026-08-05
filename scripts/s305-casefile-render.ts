/** READ-ONLY — renders the Case File for a claim with CURRENT code. Persists nothing. */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { compileEvidencePackage, formatEvidencePackageAsText } from "../src/lib/legal/evidence-compiler";
config({ path: ".env.local" });
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main() {
  const prefix = process.argv[2] ?? "9a78cffd";
  const { data } = await sb.from("claims").select("id, user_id");
  const rows = (data ?? []) as Array<{ id: string; user_id: string }>;
  const c = rows.find((x) => String(x.id).startsWith(prefix));
  if (!c) { console.error("no claim", prefix); return; }
  const pkg = await compileEvidencePackage(sb, { claimId: c.id, userId: c.user_id });
  console.log(formatEvidencePackageAsText(pkg));
}
main();
