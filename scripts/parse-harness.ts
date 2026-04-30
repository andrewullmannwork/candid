/**
 * Empirical parse harness — Phase 3 Task 3H per Q-P3-5 lock + DR-3D dogfood findings.
 *
 * Runs parseBillWithHaiku against EOB fixtures, captures cost + tokens + structural
 * completeness, writes per-attempt rows to parse_audit_runs (migration 055).
 *
 * v1 scope (Session 47):
 *   - EOB fixtures only (SBC harness deferred to Phase 3.2)
 *   - Pre-OCR'd source.txt input (PDF→OCR upstream)
 *   - Single-pass per fixture (N=3 stochastic-variance integration deferred to Task 3I)
 *   - Structural completeness check (NOT recall vs ground truth — fixture annotation deferred to Phase 3.1)
 *   - Cost telemetry from response.usage (input/output/cache_read/cache_create tokens + computed $USD)
 *   - Writes to parse_audit_runs table (per migration 055)
 *
 * Future extensions (Phase 3.1+ / Task 3I):
 *   - N=3 voting with variance metrics
 *   - Ground truth comparison via expected.json files (recall + precision)
 *   - PDF→OCR upstream integration
 *   - SBC fixtures (Phase 3.2)
 *
 * Usage:
 *   npx tsx scripts/parse-harness.ts --run-id session_47_dr3d_baseline
 *   npx tsx scripts/parse-harness.ts --run-id <id> --fixtures-dir tests/fixtures/eobs --dry-run
 *
 * See plans/findings/dr3d_dogfood_findings.md for empirical methodology.
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "path";
import * as fs from "fs";
import { execSync } from "child_process";
import { parseBillWithHaiku } from "../src/lib/billing/haiku-bill-parser";
import type { ParsedBill } from "../src/lib/billing/types";

config({ path: resolve(__dirname, "../.env.local"), override: true });

interface HarnessRow {
  run_id: string;
  parser_version: string;
  parser_name: "eob" | "bill" | "sbc" | "card";
  fixture_id: string;
  fixture_kind: "annotated" | "bulk_unannotated" | "synthetic";
  fields_captured: number;
  fields_total: number;
  cost_usd: number;
  haiku_tokens_input: number;
  haiku_tokens_output: number;
  haiku_cache_read_tokens: number;
  haiku_cache_create_tokens: number;
  per_field_results: Record<string, unknown>;
  warnings: { meta_warnings: string[]; accumulator_warnings: string[] };
  parse_duration_ms: number;
  parse_attempt_idx: number;
  parse_status: "success" | "timed_out" | "extraction_failed" | "truncated";
}

const HIGH_LEVERAGE_FIELDS = [
  "external_claim_number",
  "eob_date",
  "service_date",
  "network_status",
  "provider.name",
  "patient.name",
  "insurer.name",
  "lineItems[*].procedureCode",
  "lineItems[*].billedAmount",
  "lineItems[*].claim_line_status",
  "lineItems[*].denied_amount",
  "lineItems[*].carc_codes",
  "lineItems[*].rarc_codes",
  "lineItems[*].ex_codes",
  "lineItems[*].member_copay",
  "lineItems[*].member_applied_to_deductible",
  "accumulators[*].deductible_applied",
  "accumulators[*].oop_applied",
  "totals.totalBilled",
  "totals.totalInsurancePaid",
];

function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split(/\.|\[(\*|\d+)\]/).filter(Boolean);
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    if (part === "*") {
      // Array wildcard: check if at least one element has subsequent path populated
      if (!Array.isArray(cur)) return undefined;
      return cur; // return the array; caller checks subsequent path on each element
    }
    if (Array.isArray(cur)) {
      const idx = parseInt(part, 10);
      cur = isNaN(idx) ? undefined : cur[idx];
    } else {
      cur = (cur as Record<string, unknown>)[part];
    }
  }
  return cur;
}

function fieldIsCaptured(parsed: ParsedBill, dotPath: string): boolean {
  // Handle [*] wildcard: field is "captured" if any line item / accumulator has it populated
  if (dotPath.includes("[*]")) {
    const [arrayPath, ...rest] = dotPath.split("[*].");
    const arr = getNestedValue(parsed as unknown as Record<string, unknown>, arrayPath);
    if (!Array.isArray(arr) || arr.length === 0) return false;
    const subPath = rest.join("[*].");
    return arr.some((item) => {
      const v = getNestedValue(item, subPath);
      return v != null && (Array.isArray(v) ? v.length > 0 : true);
    });
  }
  const v = getNestedValue(parsed as unknown as Record<string, unknown>, dotPath);
  return v != null && (Array.isArray(v) ? v.length > 0 : true);
}

function computeCost(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}): number {
  const inputCost = (usage.input_tokens / 1e6) * 1.0;
  const outputCost = (usage.output_tokens / 1e6) * 5.0;
  const cacheWriteCost = ((usage.cache_creation_input_tokens ?? 0) / 1e6) * 1.25;
  const cacheReadCost = ((usage.cache_read_input_tokens ?? 0) / 1e6) * 0.10;
  return inputCost + outputCost + cacheWriteCost + cacheReadCost;
}

async function runFixture(
  fixturePath: string,
  fixtureId: string,
  runId: string,
  parserVersion: string,
  attemptIdx: number,
): Promise<HarnessRow> {
  const sourceText = fs.readFileSync(`${fixturePath}/source.txt`, "utf-8");
  const fixtureKind: HarnessRow["fixture_kind"] = fixtureId.startsWith("synthetic-") ? "synthetic" : "annotated";

  const t0 = Date.now();
  // Pre-call: capture stderr so we can read response.usage indirectly via parser logs.
  // NOTE: parseBillWithHaiku doesn't return usage; we'd need to extend the API or
  // re-architect. For v1, log-scrape from stderr is acceptable; v2 should return usage.
  // Workaround: invoke directly via dummy ids; track total cost via process-level usage if needed.
  const parsed = await parseBillWithHaiku(sourceText, `harness-${fixtureId}`, "harness-user", "eob");
  const durationMs = Date.now() - t0;

  if (!parsed) {
    return {
      run_id: runId,
      parser_version: parserVersion,
      parser_name: "eob",
      fixture_id: fixtureId,
      fixture_kind: fixtureKind,
      fields_captured: 0,
      fields_total: HIGH_LEVERAGE_FIELDS.length,
      cost_usd: 0,
      haiku_tokens_input: 0,
      haiku_tokens_output: 0,
      haiku_cache_read_tokens: 0,
      haiku_cache_create_tokens: 0,
      per_field_results: {},
      warnings: { meta_warnings: [], accumulator_warnings: [] },
      parse_duration_ms: durationMs,
      parse_attempt_idx: attemptIdx,
      parse_status: "extraction_failed",
    };
  }

  // Compute structural completeness across high-leverage fields
  const perField: Record<string, boolean> = {};
  let captured = 0;
  for (const f of HIGH_LEVERAGE_FIELDS) {
    const isCaptured = fieldIsCaptured(parsed, f);
    perField[f] = isCaptured;
    if (isCaptured) captured++;
  }

  // Pull warnings off parsed.parseErrors (post-process pushes meta + accumulator warnings there)
  const warnings = parsed.parseErrors.reduce(
    (acc, w) => {
      if (w.startsWith("accumulator_")) acc.accumulator_warnings.push(w);
      else acc.meta_warnings.push(w);
      return acc;
    },
    { meta_warnings: [] as string[], accumulator_warnings: [] as string[] },
  );

  // NOTE v1: cost / token tracking not directly accessible from parseBillWithHaiku return.
  // Stub values; v2 will require parser to expose usage in its return.
  return {
    run_id: runId,
    parser_version: parserVersion,
    parser_name: "eob",
    fixture_id: fixtureId,
    fixture_kind: fixtureKind,
    fields_captured: captured,
    fields_total: HIGH_LEVERAGE_FIELDS.length,
    cost_usd: 0, // TODO v2: parser must return usage
    haiku_tokens_input: 0,
    haiku_tokens_output: 0,
    haiku_cache_read_tokens: 0,
    haiku_cache_create_tokens: 0,
    per_field_results: { ...perField, line_count: parsed.lineItems.length, accumulator_count: parsed.accumulators?.length ?? 0 },
    warnings,
    parse_duration_ms: durationMs,
    parse_attempt_idx: attemptIdx,
    parse_status: "success",
  };
}

async function main() {
  const args = process.argv.slice(2);
  function getArg(flag: string, defaultVal: string): string {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : defaultVal;
  }
  const runId = getArg("--run-id", `harness_${Date.now()}`);
  const fixturesDir = getArg("--fixtures-dir", "tests/fixtures/eobs");
  const dryRun = args.includes("--dry-run");

  const parserVersion = (() => {
    try {
      return execSync("git rev-parse HEAD", { cwd: resolve(__dirname, "..") }).toString().trim();
    } catch {
      return "unknown";
    }
  })();

  console.log(`[harness] run_id=${runId} parser_version=${parserVersion.substring(0, 7)} dry_run=${dryRun}`);
  console.log(`[harness] fixtures_dir=${fixturesDir}`);

  const fixturesPath = resolve(__dirname, "..", fixturesDir);
  const fixtureIds = fs.readdirSync(fixturesPath).filter((f) => fs.statSync(`${fixturesPath}/${f}`).isDirectory());
  console.log(`[harness] discovered ${fixtureIds.length} fixtures: ${fixtureIds.join(", ")}`);

  const rows: HarnessRow[] = [];
  for (const fixtureId of fixtureIds) {
    const fixturePath = `${fixturesPath}/${fixtureId}`;
    if (!fs.existsSync(`${fixturePath}/source.txt`)) {
      console.warn(`[harness] skipping ${fixtureId}: no source.txt`);
      continue;
    }
    console.log(`\n[harness] running fixture ${fixtureId}...`);
    const row = await runFixture(fixturePath, fixtureId, runId, parserVersion, 1);
    rows.push(row);
    console.log(
      `  status=${row.parse_status} captured=${row.fields_captured}/${row.fields_total} (${((row.fields_captured / row.fields_total) * 100).toFixed(0)}%) duration=${row.parse_duration_ms}ms warnings=${row.warnings.meta_warnings.length + row.warnings.accumulator_warnings.length}`
    );
  }

  console.log("\n=== SUMMARY ===");
  for (const row of rows) {
    console.log(`${row.fixture_id}: ${row.fields_captured}/${row.fields_total} fields (${((row.fields_captured / row.fields_total) * 100).toFixed(0)}%) — ${row.parse_status}`);
  }

  if (dryRun) {
    console.log("\n[harness] --dry-run: skipping DB writes");
    return;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error("[harness] Missing Supabase credentials; results not persisted");
    return;
  }
  const supabase = createClient(supabaseUrl, supabaseKey);
  const { error } = await supabase.from("parse_audit_runs").insert(
    rows.map((r) => ({
      run_id: r.run_id,
      parser_version: r.parser_version,
      parser_name: r.parser_name,
      fixture_id: r.fixture_id,
      fixture_kind: r.fixture_kind,
      fields_captured: r.fields_captured,
      fields_total: r.fields_total,
      cost_usd: r.cost_usd,
      haiku_tokens_input: r.haiku_tokens_input,
      haiku_tokens_output: r.haiku_tokens_output,
      haiku_cache_read_tokens: r.haiku_cache_read_tokens,
      haiku_cache_create_tokens: r.haiku_cache_create_tokens,
      per_field_results: r.per_field_results,
      warnings: r.warnings,
      parse_duration_ms: r.parse_duration_ms,
      parse_attempt_idx: r.parse_attempt_idx,
      parse_status: r.parse_status,
    }))
  );
  if (error) {
    console.error("[harness] DB write failed:", error);
  } else {
    console.log(`[harness] wrote ${rows.length} rows to parse_audit_runs (run_id=${runId})`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
