/**
 * One-time cleanup: collapse duplicate active dispute_outcomes rows.
 *
 * Groups by (user_id, claim_line_item_id, dispute_type) among non-resolved
 * rows. For each group with >1 row: keeps the most recent row, adopts a
 * letter_content from any sibling if the keeper's is null, takes the max
 * amount_disputed, then deletes the rest.
 *
 * Rows with NULL claim_line_item_id are skipped — no safe dedup key.
 * Resolved rows (won/lost/settled/withdrawn/*_on_escalation) are untouched.
 *
 * Usage:
 *   npx tsx scripts/dedupe-existing-disputes.ts --dry-run   # report only
 *   npx tsx scripts/dedupe-existing-disputes.ts             # execute
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(__dirname, "../.env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const RESOLVED_STATUSES = [
  "won",
  "lost",
  "settled",
  "withdrawn",
  "won_on_escalation",
  "settled_on_escalation",
];

interface DisputeRow {
  id: string;
  user_id: string;
  claim_line_item_id: string | null;
  dispute_type: string;
  status: string;
  amount_disputed: number | null;
  letter_content: string | null;
  created_at: string;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment");
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  console.log(`\nDispute dedup cleanup`);
  console.log(`  Mode: ${dryRun ? "DRY RUN" : "LIVE"}\n`);

  const { data, error } = await supabase
    .from("dispute_outcomes")
    .select("id, user_id, claim_line_item_id, dispute_type, status, amount_disputed, letter_content, created_at")
    .not("claim_line_item_id", "is", null)
    .not("status", "in", `(${RESOLVED_STATUSES.join(",")})`)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Query failed:", error);
    process.exit(1);
  }

  const rows = (data as DisputeRow[] | null) ?? [];
  if (rows.length === 0) {
    console.log("No active disputes with line items. Nothing to do.");
    return;
  }

  const groups = new Map<string, DisputeRow[]>();
  for (const row of rows) {
    const key = `${row.user_id}|${row.claim_line_item_id}|${row.dispute_type}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }

  const duplicateGroups = Array.from(groups.entries()).filter(([, rs]) => rs.length > 1);
  if (duplicateGroups.length === 0) {
    console.log(`Scanned ${rows.length} active disputes. No duplicates found.`);
    return;
  }

  console.log(`Scanned ${rows.length} active disputes.`);
  console.log(`Found ${duplicateGroups.length} duplicate groups covering ${duplicateGroups.reduce((sum, [, rs]) => sum + rs.length, 0)} rows.\n`);

  let rowsUpdated = 0;
  let rowsDeleted = 0;

  for (const [key, groupRows] of duplicateGroups) {
    // Rows are already sorted DESC by created_at (from the query); keeper is rows[0].
    const [keeper, ...losers] = groupRows;
    const loserIds = losers.map((r) => r.id);

    const mergedAmount = Math.max(
      ...groupRows.map((r) => Number(r.amount_disputed) || 0)
    );
    const mergedLetter = keeper.letter_content
      ?? groupRows.find((r) => r.letter_content)?.letter_content
      ?? null;

    const needsUpdate =
      (Number(keeper.amount_disputed) || 0) !== mergedAmount ||
      (keeper.letter_content ?? null) !== mergedLetter;

    console.log(`  Group ${key}`);
    console.log(`    Keep: ${keeper.id} (created ${keeper.created_at})`);
    console.log(`    Drop: ${loserIds.join(", ")}`);
    if (needsUpdate) {
      console.log(`    Merge: amount_disputed=$${mergedAmount}, letter_content=${mergedLetter ? "present" : "null"}`);
    }

    if (dryRun) continue;

    if (needsUpdate) {
      const { error: updateError } = await supabase
        .from("dispute_outcomes")
        .update({
          amount_disputed: mergedAmount,
          letter_content: mergedLetter,
          updated_at: new Date().toISOString(),
        })
        .eq("id", keeper.id);
      if (updateError) {
        console.error(`    Update failed:`, updateError);
        continue;
      }
      rowsUpdated += 1;
    }

    const { error: deleteError } = await supabase
      .from("dispute_outcomes")
      .delete()
      .in("id", loserIds);
    if (deleteError) {
      console.error(`    Delete failed:`, deleteError);
      continue;
    }
    rowsDeleted += loserIds.length;
  }

  console.log(`\nSummary`);
  console.log(`  Groups processed: ${duplicateGroups.length}`);
  if (dryRun) {
    const wouldDelete = duplicateGroups.reduce((sum, [, rs]) => sum + rs.length - 1, 0);
    console.log(`  Would update: up to ${duplicateGroups.length} rows`);
    console.log(`  Would delete: ${wouldDelete} rows`);
    console.log(`\n  (Dry run — no writes performed. Re-run without --dry-run to execute.)`);
  } else {
    console.log(`  Rows updated: ${rowsUpdated}`);
    console.log(`  Rows deleted: ${rowsDeleted}`);
  }
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
