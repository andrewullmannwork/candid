// S330 — DEV delta for mig 235: the dfy_sign_merge function (applied via the ad-hoc exec_sql RPC, verbatim from the file).
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import { readFileSync } from "node:fs";
dotenv.config({ path: ".env.local" });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!; const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!url.includes("wdpk")) { console.error("REFUSING: not DEV"); process.exit(2); }
const sb = createClient(url, key);
(async () => {
  const sql = readFileSync("supabase/migrations/235_dfy_operator_lane.sql", "utf8");
  const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.dfy_sign_merge(");
  if (start < 0) throw new Error("function not in the mig");
  const block = sql.slice(start);
  const fnEnd = block.indexOf("$$;") + 3;
  const stmts = [block.slice(0, fnEnd), ...block.slice(fnEnd).split("\n").map((l) => l.trim()).filter((l) => l.startsWith("REVOKE") || l.startsWith("GRANT"))];
  for (const st of stmts) {
    const { error } = await sb.rpc("exec_sql", { query: st });
    if (error) { console.error("FAILED:", st.slice(0, 60), error.message); process.exit(1); }
    console.log("applied:", st.slice(0, 60).replace(/\s+/g, " "), "…");
  }
  const { data, error } = await sb.rpc("dfy_sign_merge", { p_engagement: "00000000-0000-0000-0000-000000000000", p_key: "x", p_ref: {}, p_required: ["x"] });
  console.log("smoke (no such row):", error ? error.message : `${Array.isArray(data) ? data.length : 0} rows`);
})();
