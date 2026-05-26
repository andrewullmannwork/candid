#!/usr/bin/env tsx
/**
 * Ing-I (S133) — Backfill candidate_suggestions for existing pending rows.
 *
 * One-time admin script: walks all `service_catalog_admin_review_queue` rows
 * where status='pending' AND candidate_suggestions IS NULL, runs the 2-pass
 * resolver, and persists results to the cache columns. Subsequent admin UI
 * renders read from cache without firing Haiku per render.
 *
 * Per Ship Gate G3: this script also serves as the pre-PR PROD-corpus smoke
 * — operator runs it on PROD, spot-checks top-3 candidates per row, and tunes
 * thresholds via candidate_suggestions_config flag if false-positive rate is
 * too high before opening user-facing UI.
 *
 * Run:
 *   - PROD: npx tsx scripts/ing-i-backfill-candidate-suggestions.ts --apply
 *   - DRY RUN (default): npx tsx scripts/ing-i-backfill-candidate-suggestions.ts
 *
 * Env required:
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY
 *   - ANTHROPIC_API_KEY (only required if Pass 2 fires for any row)
 *
 * Cost: Pass 1 is free (DB-only). Pass 2 fires per row that has weak Pass 1
 * results; each call writes one row to parse_cost_events for Cost-F visibility.
 * Expected total cost on a pre-launch corpus: < $1 USD.
 */

import { createClient } from "@supabase/supabase-js";
import {
  loadResolverConfig,
  resolveSlugCandidates,
  type CandidateSuggestion,
} from "../src/lib/parser/review-queue-candidates";

const apply = process.argv.includes("--apply");

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "Missing env: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required.",
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

interface QueueRow {
  id: string;
  proposed_service_slug: string;
  proposed_service_label: string | null;
}

async function main(): Promise<void> {
  console.log(`Ing-I backfill — apply=${apply}`);

  const config = await loadResolverConfig(supabase);
  console.log("Resolver config:", config);

  const { data: rows, error } = await supabase
    .from("service_catalog_admin_review_queue")
    .select("id, proposed_service_slug, proposed_service_label")
    .eq("status", "pending")
    .is("candidate_suggestions", null)
    .order("created_at", { ascending: true });

  if (error) {
    console.error(`Failed to load pending rows: ${error.message}`);
    process.exit(1);
  }

  const pending = (rows ?? []) as QueueRow[];
  console.log(`Found ${pending.length} pending rows with no cached candidates.`);

  if (pending.length === 0) {
    console.log("Nothing to backfill. Exiting clean.");
    return;
  }

  let computed = 0;
  let writeOk = 0;
  let writeFail = 0;
  const sample: Array<{ row: QueueRow; candidates: CandidateSuggestion[] }> = [];

  for (const row of pending) {
    process.stdout.write(`  resolving ${row.proposed_service_slug}... `);
    try {
      const candidates = await resolveSlugCandidates({
        supabase,
        proposedSlug: row.proposed_service_slug,
        proposedLabel: row.proposed_service_label,
        config,
        adminUserId: null, // admin-script attribution; Cost-F surfaces this
      });
      computed += 1;
      sample.push({ row, candidates });
      process.stdout.write(`${candidates.length} candidates\n`);

      if (apply) {
        const { error: writeErr } = await supabase
          .from("service_catalog_admin_review_queue")
          .update({
            candidate_suggestions: candidates,
            candidate_suggestions_computed_at: new Date().toISOString(),
          })
          .eq("id", row.id);

        if (writeErr) {
          writeFail += 1;
          console.warn(`    [WRITE FAIL] ${writeErr.message}`);
        } else {
          writeOk += 1;
        }
      }
    } catch (err) {
      console.warn(
        `    [RESOLVE FAIL] ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.log(`\n─── Summary ─────────────────────────────────────`);
  console.log(`  Computed: ${computed} / ${pending.length}`);
  if (apply) {
    console.log(`  Cache writes OK: ${writeOk}`);
    console.log(`  Cache writes FAIL: ${writeFail}`);
  } else {
    console.log(`  DRY RUN — no writes (re-run with --apply to persist).`);
  }

  // Show first 5 rows for operator spot-check (Ship Gate G3 evidence)
  console.log(`\n─── Spot-check (first 5 rows) ───────────────────`);
  for (const { row, candidates } of sample.slice(0, 5)) {
    console.log(
      `\n  proposed: ${row.proposed_service_slug}${row.proposed_service_label ? ` (${row.proposed_service_label})` : ""}`,
    );
    if (candidates.length === 0) {
      console.log(`    (no candidates above threshold — admin should PROMOTE-as-new OR REJECT)`);
      continue;
    }
    for (const c of candidates) {
      console.log(
        `    [${c.source}] ${c.match_score.toFixed(2)} → ${c.slug}${c.name ? ` (${c.name})` : ""}`,
      );
    }
  }
}

main().catch((err) => {
  console.error("Backfill threw unexpectedly:", err);
  process.exit(1);
});
