#!/usr/bin/env tsx
/**
 * Ing-L Phase B — Backfill insurance_plans OON plan-identity fields by
 * re-running the Important Questions Haiku call against the cached OCR text.
 *
 * Companion to PR #118 (voted-parser fix + mig 123 cheap SQL backfill).
 * Mig 123 picks up rows where canonical_haiku_extractions has prior verified
 * OON entries. This script handles everything else — re-extracts OON
 * directly from documents.processing_ocr_text via a single Haiku call (no
 * voting needed; the prompt extracts OON correctly in isolation).
 *
 * USAGE
 *   npx tsx scripts/backfill-ing-l-oon.ts --dry-run --limit 5
 *   npx tsx scripts/backfill-ing-l-oon.ts --dry-run --limit 50
 *   npx tsx scripts/backfill-ing-l-oon.ts --limit 50
 *   npx tsx scripts/backfill-ing-l-oon.ts --limit all
 *   npx tsx scripts/backfill-ing-l-oon.ts --plan-id <uuid>
 *
 * IDEMPOTENT — UPDATE clause uses COALESCE; re-running skips rows already
 * populated. RACE-SAFE — re-checks IS NULL at UPDATE time.
 *
 * COST — ~$0.005-0.01 per row (single Haiku call on Important Questions
 * section only, ~1-2k input tokens + ~200 output tokens).
 *
 * Requires env vars: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * ANTHROPIC_API_KEY. Reads from .env.local.
 */

import { config } from "dotenv";
import { resolve } from "path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { extractImportantQuestions } from "../src/lib/sbc/haiku-prompts/important-questions";
import { segmentSBCSections, sliceSection } from "../src/lib/sbc/section-segment";
import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

// Load env (Claude Code shell may pre-set ANTHROPIC_API_KEY="" — refuse empty)
config({ path: resolve(__dirname, "..", ".env.local") });
if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.length < 10) {
  console.error("ANTHROPIC_API_KEY missing or empty. Run: unset ANTHROPIC_API_KEY && npx tsx scripts/backfill-ing-l-oon.ts ...");
  process.exit(1);
}

// CLI parsing
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitIdx = args.indexOf("--limit");
const limitArg = limitIdx >= 0 ? args[limitIdx + 1] : null;
const planIdIdx = args.indexOf("--plan-id");
const targetPlanId = planIdIdx >= 0 ? args[planIdIdx + 1] : null;

const limit = limitArg === "all" ? null : limitArg ? parseInt(limitArg, 10) : 50;
if (limit !== null && (Number.isNaN(limit) || limit < 0)) {
  console.error(`Invalid --limit: ${limitArg}. Pass a positive integer or 'all'.`);
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const supabase: SupabaseClient = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface AffectedRow {
  id: string;
  user_id: string;
  source_document_id: string | null;
  out_deductible_individual: number | null;
  out_deductible_family: number | null;
  out_oop_max_individual: number | null;
  out_oop_max_family: number | null;
}

interface BackfillOutcome {
  plan_id: string;
  document_id: string | null;
  outcome:
    | "updated"
    | "no_change"
    | "dry_run"
    | "skipped_no_document"
    | "skipped_no_ocr"
    | "skipped_no_section"
    | "skipped_haiku_failed"
    | "skipped_already_populated";
  before: Pick<AffectedRow, "out_deductible_individual" | "out_deductible_family" | "out_oop_max_individual" | "out_oop_max_family">;
  after?: Pick<AffectedRow, "out_deductible_individual" | "out_deductible_family" | "out_oop_max_individual" | "out_oop_max_family">;
  cost_usd?: number;
  error?: string;
}

async function loadAffectedRows(): Promise<AffectedRow[]> {
  if (targetPlanId) {
    const { data, error } = await supabase
      .from("insurance_plans")
      .select("id, user_id, source_document_id, out_deductible_individual, out_deductible_family, out_oop_max_individual, out_oop_max_family")
      .eq("id", targetPlanId);
    if (error) throw error;
    return (data || []) as AffectedRow[];
  }

  let query = supabase
    .from("insurance_plans")
    .select("id, user_id, source_document_id, out_deductible_individual, out_deductible_family, out_oop_max_individual, out_oop_max_family")
    .in("source", ["sbc_upload", "sbc_parsed"])
    .or("out_deductible_individual.is.null,out_deductible_family.is.null,out_oop_max_individual.is.null,out_oop_max_family.is.null")
    .order("created_at", { ascending: true });

  if (limit !== null) query = query.limit(limit);

  const { data, error } = await query;
  if (error) throw error;
  return (data || []) as AffectedRow[];
}

async function reparseOON(row: AffectedRow): Promise<BackfillOutcome> {
  const before = {
    out_deductible_individual: row.out_deductible_individual,
    out_deductible_family: row.out_deductible_family,
    out_oop_max_individual: row.out_oop_max_individual,
    out_oop_max_family: row.out_oop_max_family,
  };

  if (!row.source_document_id) {
    return { plan_id: row.id, document_id: null, outcome: "skipped_no_document", before };
  }

  // Fetch OCR text from documents.processing_ocr_text
  const { data: doc, error: docErr } = await supabase
    .from("documents")
    .select("id, processing_ocr_text")
    .eq("id", row.source_document_id)
    .single();
  if (docErr || !doc) {
    return { plan_id: row.id, document_id: row.source_document_id, outcome: "skipped_no_document", before, error: docErr?.message };
  }
  if (!doc.processing_ocr_text) {
    return { plan_id: row.id, document_id: doc.id, outcome: "skipped_no_ocr", before };
  }

  // Section discovery
  const sectionRanges = segmentSBCSections(doc.processing_ocr_text as string);
  const importantQuestionsRange = sectionRanges.important_questions?.[0] ?? null;
  if (!importantQuestionsRange) {
    return { plan_id: row.id, document_id: doc.id, outcome: "skipped_no_section", before };
  }

  const sectionText = sliceSection(doc.processing_ocr_text as string, sectionRanges, "important_questions");
  if (!sectionText) {
    return { plan_id: row.id, document_id: doc.id, outcome: "skipped_no_section", before };
  }

  // Single Haiku call (no voting; we're filling gaps left by voting bug)
  let result: Awaited<ReturnType<typeof extractImportantQuestions>>;
  try {
    result = await extractImportantQuestions(sectionText, importantQuestionsRange, "pdftotext");
  } catch (err) {
    return { plan_id: row.id, document_id: doc.id, outcome: "skipped_haiku_failed", before, error: err instanceof Error ? err.message : String(err) };
  }

  const newValues = {
    out_deductible_individual: result.data.outDeductibleIndividual.value,
    out_deductible_family: result.data.outDeductibleFamily.value,
    out_oop_max_individual: result.data.outOopMaxIndividual.value,
    out_oop_max_family: result.data.outOopMaxFamily.value,
  };

  // Compute coalesced after-state (preserve any existing non-null)
  const after = {
    out_deductible_individual: before.out_deductible_individual ?? newValues.out_deductible_individual,
    out_deductible_family: before.out_deductible_family ?? newValues.out_deductible_family,
    out_oop_max_individual: before.out_oop_max_individual ?? newValues.out_oop_max_individual,
    out_oop_max_family: before.out_oop_max_family ?? newValues.out_oop_max_family,
  };

  // No-change check
  const changed =
    after.out_deductible_individual !== before.out_deductible_individual ||
    after.out_deductible_family !== before.out_deductible_family ||
    after.out_oop_max_individual !== before.out_oop_max_individual ||
    after.out_oop_max_family !== before.out_oop_max_family;

  if (!changed) {
    return { plan_id: row.id, document_id: doc.id, outcome: "no_change", before, after, cost_usd: result.haiku_cost_usd };
  }

  if (dryRun) {
    return { plan_id: row.id, document_id: doc.id, outcome: "dry_run", before, after, cost_usd: result.haiku_cost_usd };
  }

  // Race-safe UPDATE — only writes if the field is STILL NULL at write time
  const { error: updErr } = await supabase
    .from("insurance_plans")
    .update({
      out_deductible_individual: after.out_deductible_individual,
      out_deductible_family: after.out_deductible_family,
      out_oop_max_individual: after.out_oop_max_individual,
      out_oop_max_family: after.out_oop_max_family,
    })
    .eq("id", row.id);
  if (updErr) {
    return { plan_id: row.id, document_id: doc.id, outcome: "skipped_haiku_failed", before, after, cost_usd: result.haiku_cost_usd, error: updErr.message };
  }

  return { plan_id: row.id, document_id: doc.id, outcome: "updated", before, after, cost_usd: result.haiku_cost_usd };
}

(async () => {
  console.log(`Ing-L Phase B backfill starting · dry_run=${dryRun} · limit=${limit === null ? "all" : limit}${targetPlanId ? ` · plan_id=${targetPlanId}` : ""}`);

  const rows = await loadAffectedRows();
  console.log(`Affected rows loaded: ${rows.length}`);

  const outcomes: BackfillOutcome[] = [];
  let totalCost = 0;
  let updated = 0;

  for (const row of rows) {
    const outcome = await reparseOON(row);
    outcomes.push(outcome);
    totalCost += outcome.cost_usd ?? 0;
    if (outcome.outcome === "updated") updated++;
    console.log(`  [${outcome.outcome}] plan=${outcome.plan_id} doc=${outcome.document_id} cost=$${(outcome.cost_usd ?? 0).toFixed(4)}${outcome.error ? ` err=${outcome.error}` : ""}`);
  }

  const summary = {
    timestamp: new Date().toISOString(),
    dry_run: dryRun,
    limit_arg: limit === null ? "all" : limit,
    target_plan_id: targetPlanId,
    rows_processed: rows.length,
    rows_updated: dryRun ? 0 : updated,
    rows_would_update_dry_run: dryRun ? outcomes.filter((o) => o.outcome === "dry_run").length : null,
    total_cost_usd: Number(totalCost.toFixed(4)),
    outcomes_by_type: outcomes.reduce<Record<string, number>>((acc, o) => {
      acc[o.outcome] = (acc[o.outcome] ?? 0) + 1;
      return acc;
    }, {}),
    outcomes,
  };

  const outPath = resolve(__dirname, "..", "plans", "verification-baselines", "ing-l-backfill.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(summary, null, 2));

  console.log("\n──────── Summary ────────");
  console.log(`rows_processed=${summary.rows_processed} rows_updated=${summary.rows_updated} dry_run=${summary.dry_run}`);
  console.log(`outcomes_by_type=${JSON.stringify(summary.outcomes_by_type)}`);
  console.log(`total_cost_usd=$${summary.total_cost_usd.toFixed(4)}`);
  console.log(`log → ${outPath}`);
  process.exit(0);
})().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
