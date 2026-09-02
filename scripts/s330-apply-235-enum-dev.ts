// DEV delta for mig 235 (the enum values added at PR-DFY-2). DEV-guarded.
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
if (!url.includes("wdpk")) { console.error("REFUSING: not DEV"); process.exit(2); }
const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const vals = ["dfy_authorization_hipaa_cmia", "dfy_authorized_representative_designation", "dfy_scope_of_engagement", "dfy_fee_agreement", "dfy_sponsor_paid_disclosure"];
(async () => {
  for (const v of vals) {
    const r = await sb.rpc("exec_sql", { query: `ALTER TYPE public.consent_type ADD VALUE IF NOT EXISTS '${v}'` });
    console.log(r.error ? `✗ ${v}: ${r.error.message}` : `✓ ${v}`);
  }
  const chk = await sb.rpc("exec_sql", { query: "select 1" });
  console.log("rpc ok:", !chk.error);
})();
