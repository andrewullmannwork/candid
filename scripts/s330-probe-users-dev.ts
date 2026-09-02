// S330 DEV read-only probe: who can play member / operator in the test round.
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!url.includes("wdpk")) { console.error("REFUSING: not the DEV project:", url); process.exit(2); }
const sb = createClient(url, key);
(async () => {
  const { data, error } = await sb.from("users").select("id, email, is_admin, is_operator, created_at").order("created_at", { ascending: false }).limit(15);
  if (error) { console.error(error); process.exit(1); }
  for (const u of data ?? []) console.log(`${u.id.slice(0, 8)} · ${u.email ?? "(no email)"} · admin=${u.is_admin} · operator=${u.is_operator} · ${String(u.created_at).slice(0, 10)}`);
  const { data: claims } = await sb.from("claims").select("id, user_id, provider_name, date_of_service, created_at").order("created_at", { ascending: false }).limit(12);
  console.log("--- recent claims (id · owner · provider · dos) ---");
  for (const c of claims ?? []) console.log(`${c.id.slice(0, 8)} · ${String(c.user_id).slice(0, 8)} · ${c.provider_name ?? "-"} · ${c.date_of_service ?? "-"}`);
})();
