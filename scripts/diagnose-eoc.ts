/**
 * One-shot diagnostic — counts warning types from a parse_audit_runs row.
 * Used during Phase 3.1A.1 iteration to understand which failure modes dominate.
 *
 * Usage: npx tsx scripts/diagnose-eoc.ts <run_id> <fixture_id>
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(__dirname, "../.env.local"), override: true });

async function main() {
  const runId = process.argv[2];
  const fixtureId = process.argv[3];
  if (!runId || !fixtureId) {
    console.error("Usage: tsx scripts/diagnose-eoc.ts <run_id> <fixture_id>");
    process.exit(1);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing Supabase URL or service role key");
    process.exit(1);
  }
  const supabase = createClient(url, key);

  const { data, error } = await supabase
    .from("parse_audit_runs")
    .select("warnings, fields_captured, fields_total, cost_usd, parse_duration_ms, per_field_results")
    .eq("run_id", runId)
    .eq("fixture_id", fixtureId)
    .limit(1)
    .single();

  if (error) {
    console.error("Query error:", error);
    process.exit(1);
  }

  console.log(`\n=== ${fixtureId} (${runId}) ===`);
  console.log(`Captured: ${data.fields_captured}/${data.fields_total}`);
  console.log(`Cost: $${data.cost_usd}`);
  console.log(`Duration: ${data.parse_duration_ms}ms`);
  console.log(`P-8 metrics:`, data.warnings?.pattern_p8_metrics);

  const allWarnings = [
    ...(data.warnings?.meta_warnings ?? []),
    ...(data.warnings?.excerpt_verification_warnings ?? []),
  ];
  const counts: Record<string, number> = {};
  for (const w of allWarnings) {
    const key = String(w).split(":")[0] || "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  console.log(`\nWarning type counts:`);
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${v.toString().padStart(4)}  ${k}`);
  }

  // Print some sample 'not_found' warnings to see which fields failed
  const notFoundWarnings = allWarnings.filter((w) => String(w).includes("source_excerpt_not_found"));
  console.log(`\n${notFoundWarnings.length} not_found warnings (sample first 10):`);
  for (const w of notFoundWarnings.slice(0, 10)) console.log(`  ${w}`);

  // Print self-check outcomes
  const scWarnings = allWarnings.filter((w) => String(w).startsWith("self_check_"));
  if (scWarnings.length > 0) {
    const scCounts: Record<string, number> = {};
    for (const w of scWarnings) {
      const key = String(w).split(":")[0];
      scCounts[key] = (scCounts[key] ?? 0) + 1;
    }
    console.log(`\nSelf-check outcomes:`);
    for (const [k, v] of Object.entries(scCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${v.toString().padStart(4)}  ${k}`);
    }
  }

  // Print actual emitted excerpts for failing fields
  const sections = (data.per_field_results as { sections?: Record<string, unknown> })?.sections ?? {};
  console.log(`\n--- Sample failing excerpts ---`);
  let printed = 0;
  for (const [sectionName, section] of Object.entries(sections)) {
    if (printed >= 8) break;
    const s = section as { data?: { codes?: unknown[]; criteria?: unknown[]; definitions?: unknown[] } };
    const items = s.data?.codes ?? s.data?.criteria ?? s.data?.definitions ?? null;
    if (!items) continue;
    for (let i = 0; i < items.length && printed < 8; i++) {
      const item = items[i] as { source_excerpt?: string; source_excerpt_verified?: string; term?: string; criteria_text?: string; billing_code?: string };
      if (item.source_excerpt_verified === "not_found" && item.source_excerpt) {
        console.log(`\n[${sectionName}[${i}]] verified=${item.source_excerpt_verified}`);
        if (item.term) console.log(`  term: ${JSON.stringify(item.term)}`);
        if (item.billing_code) console.log(`  code: ${JSON.stringify(item.billing_code)}`);
        console.log(`  emitted excerpt: ${JSON.stringify(item.source_excerpt)}`);
        printed++;
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
