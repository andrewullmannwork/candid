/**
 * Transient driver: test DB connection + dump service_catalog.
 * Written by Sonnet sub-agent for Phase 0 GT build. Delete after use.
 */
import { config } from "dotenv";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";

async function main() {
  config({ path: resolve(process.cwd(), ".env.local") });
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const { data, error } = await sb
    .from("service_catalog")
    .select("slug,name,category,description")
    .order("category,slug");
  if (error) {
    console.error("DB ERROR:", error.message);
    process.exit(1);
  }
  console.log("service_catalog rows:", data.length);
  console.log(JSON.stringify(data, null, 2));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
