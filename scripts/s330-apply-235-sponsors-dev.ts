import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
if (!url.includes("wdpk")) { console.error("REFUSING: not DEV"); process.exit(2); }
const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const stmts = [
  `CREATE TABLE IF NOT EXISTS public.dfy_sponsors (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL UNIQUE, name text NOT NULL, contact_email text, agreement_signed_at timestamptz, active boolean NOT NULL DEFAULT true, terms jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`,
  `ALTER TABLE public.dfy_sponsors ENABLE ROW LEVEL SECURITY`,
  `REVOKE ALL ON TABLE public.dfy_sponsors FROM anon, authenticated`,
  `ALTER TABLE public.dfy_engagements ADD COLUMN IF NOT EXISTS sponsor_id uuid REFERENCES public.dfy_sponsors(id) ON DELETE SET NULL`,
];
(async () => {
  for (const q of stmts) { const r = await sb.rpc("exec_sql", { query: q }); console.log(r.error ? `✗ ${r.error.message}` : `✓ ${q.slice(0, 60)}`); }
  const t = await sb.from("dfy_sponsors").select("id", { count: "exact", head: true });
  console.log("dfy_sponsors:", t.error ? t.error.message : `present (count ${t.count})`);
})();
