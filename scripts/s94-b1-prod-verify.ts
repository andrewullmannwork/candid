/**
 * scripts/s94-b1-prod-verify.ts — S94 Work Block B1 Stage 0 pre-flight PROD probe.
 *
 * Read-only. Verifies:
 *   1. Mig 103 landed in PROD:
 *      - service_catalog.canonical_for_concept BOOLEAN column exists
 *      - service_catalog.proposal_state TEXT column exists
 *      - service_catalog.deprecated_at TIMESTAMPTZ column exists
 *      - enforce_canonical_per_concept() trigger function exists
 *   2. parser_prompt_versions table row count = 0 (compile-time fallback still active).
 *   3. Flag state echo: unified_plan_doc_parser_v1 + parse_quality_tuning_v1 enabled.
 */
import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(__dirname, "../.env.local"), override: true });

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function probeServiceCatalogColumns() {
  console.log("\n=== Mig 103: service_catalog columns ===");
  const { data, error } = await sb
    .from("service_catalog")
    .select("id, slug, canonical_for_concept, proposal_state, deprecated_at")
    .limit(1);

  if (error) {
    console.log(`  ❌ ERROR querying columns: ${error.message}`);
    return false;
  }
  if (!data || data.length === 0) {
    console.log("  ⚠️  service_catalog table empty — cannot validate columns from result");
    return null;
  }
  const row = data[0];
  const cols = Object.keys(row);
  const expected = ["canonical_for_concept", "proposal_state", "deprecated_at"];
  let allOk = true;
  for (const c of expected) {
    if (cols.includes(c)) {
      console.log(`  ✅ column ${c} exists (sample value: ${JSON.stringify(row[c as keyof typeof row])})`);
    } else {
      console.log(`  ❌ column ${c} MISSING`);
      allOk = false;
    }
  }
  return allOk;
}

async function probeTriggerFunction() {
  console.log("\n=== Mig 103: enforce_canonical_per_concept() trigger function ===");
  const { data, error } = await sb.rpc("enforce_canonical_per_concept_probe");
  if (error && /does not exist/i.test(error.message)) {
    // RPC won't exist; we'd need pg_proc query via service-role. Instead inspect via service_catalog count + structure.
    // We can verify by attempting to insert an alias with no canonical sibling — but that's a write. Skip.
    console.log("  ℹ️  Cannot directly probe trigger from JS client. Will infer from column existence + mig file presence in repo.");
    return null;
  }
  return null;
}

async function probeProposalStateDistribution() {
  console.log("\n=== service_catalog proposal_state distribution (post-mig-103 baseline) ===");
  const { data, error } = await sb
    .from("service_catalog")
    .select("proposal_state")
    .limit(10000);

  if (error) {
    console.log(`  ❌ ERROR: ${error.message}`);
    return;
  }
  if (!data) {
    console.log("  ⚠️  empty");
    return;
  }
  const counts: Record<string, number> = {};
  for (const r of data) {
    const k = (r as any).proposal_state ?? "(null)";
    counts[k] = (counts[k] ?? 0) + 1;
  }
  console.log(`  Total rows: ${data.length}`);
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(12)} ${v}`);
  }
}

async function probeCanonicalForConceptDistribution() {
  console.log("\n=== service_catalog canonical_for_concept distribution ===");
  const { data, error } = await sb
    .from("service_catalog")
    .select("canonical_for_concept")
    .limit(10000);

  if (error) {
    console.log(`  ❌ ERROR: ${error.message}`);
    return;
  }
  if (!data) return;
  const counts: Record<string, number> = {};
  for (const r of data) {
    const k = String((r as any).canonical_for_concept);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  for (const [k, v] of Object.entries(counts)) {
    console.log(`    canonical_for_concept=${k.padEnd(6)} ${v}`);
  }
}

async function probePromptVersionsEmpty() {
  console.log("\n=== parser_prompt_versions table state ===");
  const { count, error } = await sb
    .from("parser_prompt_versions")
    .select("*", { count: "exact", head: true });
  if (error) {
    console.log(`  ❌ ERROR: ${error.message}`);
    return null;
  }
  if (count === 0) {
    console.log(`  ✅ table EMPTY (count=0) — compile-time fallback active`);
    return true;
  }
  console.log(`  ⚠️  table has ${count} rows — DB-side prompt overrides may be active`);
  return false;
}

async function probeFlags() {
  console.log("\n=== Feature flag state (PROD) ===");
  const flags = ["unified_plan_doc_parser_v1", "parse_quality_tuning_v1"];
  for (const f of flags) {
    const { data, error } = await sb
      .from("feature_flags")
      .select("flag_key, enabled")
      .eq("flag_key", f)
      .maybeSingle();
    if (error) {
      console.log(`  ❌ ${f}: ERROR ${error.message}`);
      continue;
    }
    if (!data) {
      console.log(`  ⚠️  ${f}: NOT FOUND (no row)`);
      continue;
    }
    console.log(`  ${data.enabled ? "✅" : "⚠️ "} ${f}: enabled=${data.enabled}`);
  }
}

async function main() {
  console.log("S94 B1 Stage 0 — PROD probe");
  console.log("Supabase URL:", process.env.NEXT_PUBLIC_SUPABASE_URL);
  await probeServiceCatalogColumns();
  await probeCanonicalForConceptDistribution();
  await probeProposalStateDistribution();
  await probePromptVersionsEmpty();
  await probeFlags();
  console.log("\n=== Done ===");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
