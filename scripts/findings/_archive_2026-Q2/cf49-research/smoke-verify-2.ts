import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config({ path: ".env.local" });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  console.log(`DB URL: ${process.env.NEXT_PUBLIC_SUPABASE_URL}`);

  // ALL recent docs across users, any status, last 30 min
  const thirtyMinAgo = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data: docs } = await supabase
    .from("documents")
    .select("id, user_id, file_name, doc_type, classified_type, status, file_hash, created_at, processed_at")
    .gte("created_at", thirtyMinAgo)
    .order("created_at", { ascending: false })
    .limit(10);
  console.log(`\nAll docs created in last 30 min (any user, any status):`);
  for (const d of docs ?? []) {
    console.log(`  ${(d.id as string).slice(0,8)} user=${(d.user_id as string)?.slice(0,8)} status=${d.status} type=${d.doc_type}/${d.classified_type} hash=${(d.file_hash as string)?.slice(0,12)} file=${d.file_name} created=${d.created_at}`);
  }

  // Also check Andrew by email
  const { data: andrewUsers } = await supabase
    .from("users")
    .select("id, email, is_admin")
    .ilike("email", "%andrew%");
  console.log(`\nAndrew-matching users:`);
  for (const u of andrewUsers ?? []) {
    console.log(`  id=${(u.id as string).slice(0,8)} email=${u.email} is_admin=${u.is_admin}`);
  }
}
main();
