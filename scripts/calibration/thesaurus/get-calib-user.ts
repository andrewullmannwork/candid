import { config } from "dotenv";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";

config({ path: resolve(process.cwd(), ".env.local") });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
  { auth: { persistSession: false } }
);

async function main() {
  // Find any admin user to use as CALIB_USER_ID
  const { data, error } = await supabase
    .from("users")
    .select("id, email, is_admin")
    .eq("is_admin", true)
    .limit(5);

  if (error) throw new Error(`users: ${error.message}`);
  console.log("Admin users:", JSON.stringify(data, null, 2));
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
