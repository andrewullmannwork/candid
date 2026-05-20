/**
 * OPS.9 Session 1 — PROD state audit queries.
 * Read-only. No writes.
 *
 * Usage: cd /Users/andrewullmann/Desktop/candid && npx tsx scripts/findings/ops9-audit/query-prod-state.ts
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function main() {
  console.log("=== PROD URL ===");
  console.log(SUPABASE_URL);
  console.log("");

  // Task 3: migration drift — does supabase_migrations.schema_migrations exist + what's in it?
  console.log("=== Task 3a: Probe supabase_migrations.schema_migrations existence ===");
  const { data: migCheck, error: migErr } = await supabase
    .rpc("exec_sql_readonly", { query: "select count(*) from supabase_migrations.schema_migrations" })
    .single();
  if (migErr) {
    console.log(`schema_migrations table query via RPC failed: ${migErr.message}`);
    console.log("Will probe via direct PostgREST instead...");
  } else {
    console.log(`schema_migrations row count: ${JSON.stringify(migCheck)}`);
  }
  console.log("");

  // Task 6: cold-start status — canonical_plans by source + state
  console.log("=== Task 6: cold-start status — canonical_plans by source ===");
  const { data: byCount, error: byCountErr } = await supabase
    .from("canonical_plans")
    .select("source", { count: "exact" })
    .limit(1);
  if (byCountErr) {
    console.log(`canonical_plans count query failed: ${byCountErr.message}`);
  } else {
    console.log(`Total canonical_plans rows: ${(byCount as unknown as { count: number })?.length ?? "?"}`);
  }

  const { data: bySource, error: bySourceErr } = await supabase
    .from("canonical_plans")
    .select("source, state, plan_year")
    .eq("source", "admin_attested");
  if (bySourceErr) {
    console.log(`admin_attested query failed: ${bySourceErr.message}`);
  } else {
    const byStateCount: Record<string, number> = {};
    const byYearCount: Record<string, number> = {};
    for (const row of bySource ?? []) {
      const r = row as { state: string | null; plan_year: number | null };
      const stateKey = r.state ?? "NULL";
      const yearKey = String(r.plan_year ?? "NULL");
      byStateCount[stateKey] = (byStateCount[stateKey] ?? 0) + 1;
      byYearCount[yearKey] = (byYearCount[yearKey] ?? 0) + 1;
    }
    console.log(`Admin-attested canonical_plans total: ${bySource?.length ?? 0}`);
    console.log(`By state: ${JSON.stringify(byStateCount, null, 2)}`);
    console.log(`By plan_year: ${JSON.stringify(byYearCount, null, 2)}`);
  }
  console.log("");

  // Task 6b: canonical_plan_services + canonical_promotion_events
  console.log("=== Task 6b: canonical_plan_services + canonical_promotion_events counts ===");
  const { count: cpsCount, error: cpsErr } = await supabase
    .from("canonical_plan_services")
    .select("*", { count: "exact", head: true });
  console.log(`canonical_plan_services total: ${cpsCount ?? "?"}${cpsErr ? ` (err: ${cpsErr.message})` : ""}`);

  const { count: cpeCount, error: cpeErr } = await supabase
    .from("canonical_promotion_events")
    .select("*", { count: "exact", head: true })
    .eq("event_type", "admin_override");
  console.log(`canonical_promotion_events (admin_override): ${cpeCount ?? "?"}${cpeErr ? ` (err: ${cpeErr.message})` : ""}`);
  console.log("");

  // Task 6c: documents seeded via S103 cold-start
  console.log("=== Task 6c: documents tagged with cold-start seeded_via ===");
  const { data: docs, error: docsErr } = await supabase
    .from("documents")
    .select("metadata, created_at")
    .not("metadata", "is", null)
    .limit(2000);
  if (docsErr) {
    console.log(`documents query failed: ${docsErr.message}`);
  } else {
    let coldStartCount = 0;
    const seedTags: Record<string, number> = {};
    for (const d of docs ?? []) {
      const meta = (d as { metadata: Record<string, unknown> | null }).metadata;
      if (meta && typeof meta === "object" && "seeded_via" in meta) {
        coldStartCount++;
        const tag = String(meta.seeded_via);
        seedTags[tag] = (seedTags[tag] ?? 0) + 1;
      }
    }
    console.log(`Documents with seeded_via tag: ${coldStartCount}`);
    console.log(`Tag breakdown: ${JSON.stringify(seedTags, null, 2)}`);
  }
  console.log("");

  // Task 3b: alternative migration drift probe — count of feature flags + critical tables
  console.log("=== Task 3b: feature_flag_rules state (sample for parity) ===");
  const { data: flags, error: flagsErr } = await supabase
    .from("feature_flag_rules")
    .select("flag_key, config")
    .order("flag_key");
  if (flagsErr) {
    console.log(`feature_flag_rules query failed: ${flagsErr.message}`);
  } else {
    console.log(`Total flag rows: ${flags?.length ?? 0}`);
    console.log(`Flag keys: ${(flags ?? []).map((f) => (f as { flag_key: string }).flag_key).join(", ")}`);
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
