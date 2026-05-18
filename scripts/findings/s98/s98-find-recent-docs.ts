/** scripts/s98-find-recent-docs.ts — Find most recent uploads across all users in target DB. */
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
  console.log(`Supabase URL: ${process.env.NEXT_PUBLIC_SUPABASE_URL}\n`);

  const { data: docs } = await sb
    .from("documents")
    .select("id,user_id,doc_type,status,processing_step,file_name,created_at,processing_total_pages,processing_completed_pages")
    .order("created_at", { ascending: false })
    .limit(10);
  console.log("--- Most recent 10 docs across all users ---");
  if (!docs || docs.length === 0) {
    console.log("  ❌ Zero docs in DB.");
    process.exit(0);
  }
  for (const d of docs) {
    console.log(
      `  ${d.created_at} | user=${(d.user_id as string).substring(0, 8)} | ${d.id.substring(0, 8)} | type=${d.doc_type} status=${d.status} step=${d.processing_step ?? "<null>"} pages=${d.processing_completed_pages ?? 0}/${d.processing_total_pages ?? "?"} | ${d.file_name ?? "<no-name>"}`,
    );
  }

  // Also list user count
  const { count: userCount } = await sb.from("users").select("id", { count: "exact", head: true });
  console.log(`\nTotal users in this DB: ${userCount}`);

  // Look for any user matching andrew*
  const { data: andrewUsers } = await sb.from("users").select("id,email,email_verified,phone_verified,created_at").ilike("email", "%andrew%").limit(5);
  console.log(`\nUsers with 'andrew' in email:`);
  for (const u of andrewUsers ?? []) {
    console.log(`  ${u.id.substring(0, 8)} | ${u.email} | email_verified=${u.email_verified} phone_verified=${u.phone_verified} | created=${u.created_at}`);
  }
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
