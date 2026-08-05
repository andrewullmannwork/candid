/**
 * S304 — retire the Ballard test re-upload that displaced the original claim.
 *
 * WHAT HAPPENED
 * -------------
 * S304's verification asked for a re-upload of 4_25.pdf to prove the single-line
 * header identity end to end. `claim-matching.ts` linked the new claim into the
 * ORIGINAL's `claim_group_id`, and the claims list shows one claim per group —
 * the newer one. So `9a78cffd` (three sent letters, a folding case, two
 * regulator filings) dropped out of the list, lost its `billState`, and with it
 * the entire guided rail, which is gated on `isFlagged`.
 *
 * WHY ONLY THE BALLARD ONE
 * ------------------------
 * The 8/21 re-upload (`4e059cb9`) also displaced its original (`6f7682dc`) — and
 * that is FINE, arguably correct: the original has no case history, and the
 * re-upload is strictly better (it carries the $33.85 unallocated_balance
 * finding, the suppressed data-trust flag, and a drafted letter). Displacement
 * only does harm when the displaced claim has a live case. That distinction is
 * the underlying defect worth fixing in the group-representative rule; this
 * script only undoes the collateral damage.
 *
 * SOFT delete (`deleted_at`), matching the schema's existing convention — the
 * claim and its line items stay intact and this is reversible by nulling the
 * column.
 *
 * Usage:
 *   npx tsx scripts/s304-retire-test-upload.ts          # dry run
 *   npx tsx scripts/s304-retire-test-upload.ts --apply
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const APPLY = process.argv.includes("--apply");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
if (!url.includes("wdpkmgezhvlmaumhwqua")) {
  console.error(`REFUSING: ${url} is not DEV.`);
  process.exit(1);
}
const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

/** The S304 test re-upload of 4_25.pdf. Its original is 9a78cffd. */
const TEST_UPLOAD = "e3b9f749-8e16-4ff9-8729-a72f7f3f8cf0";
const ORIGINAL = "9a78cffd-3d33-4575-acc9-d74d922061c7";

async function groupState(label: string) {
  const { data, error } = await sb
    .from("claims")
    .select("id, date_of_service, claim_group_id, deleted_at, created_at")
    .eq("claim_group_id", "9a408a44-0000-0000-0000-000000000000");
  // group id is looked up rather than hardcoded — read it off the original.
  const orig = await sb.from("claims").select("claim_group_id").eq("id", ORIGINAL).single();
  if (orig.error) throw new Error(orig.error.message);
  const g = orig.data.claim_group_id as string;
  const rows = await sb
    .from("claims")
    .select("id, date_of_service, deleted_at, created_at")
    .eq("claim_group_id", g)
    .order("created_at");
  if (rows.error) throw new Error(rows.error.message);
  console.log(`\n${label} (group ${g.slice(0, 8)}):`);
  for (const r of rows.data as Array<Record<string, unknown>>) {
    console.log(
      `  ${(r.id as string).slice(0, 8)}  ${r.date_of_service}  deleted=${r.deleted_at ?? "no"}  created=${String(r.created_at).slice(0, 19)}`,
    );
  }
  void data;
  void error;
}

async function main() {
  console.log(`Project: ${url} (DEV)`);
  console.log(APPLY ? "MODE: APPLY — this writes.\n" : "MODE: dry run.\n");

  // What the original still holds — the thing worth protecting.
  const disputes = await sb
    .from("dispute_outcomes")
    .select("id, dispute_type, status")
    .eq("claim_id", ORIGINAL);
  if (disputes.error) throw new Error(disputes.error.message);
  console.log(`Original ${ORIGINAL.slice(0, 8)} holds ${disputes.data.length} letter(s):`);
  for (const d of disputes.data as Array<Record<string, unknown>>) {
    console.log(`  ${(d.id as string).slice(0, 8)}  ${d.dispute_type}  ${d.status}`);
  }

  await groupState("BEFORE");

  if (!APPLY) {
    console.log(`\nWould soft-delete ${TEST_UPLOAD.slice(0, 8)}. Re-run with --apply.`);
    return;
  }

  const res = await sb
    .from("claims")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", TEST_UPLOAD)
    .is("deleted_at", null);
  if (res.error) throw new Error(`soft-delete: ${res.error.message}`);

  await groupState("AFTER");

  // Never trust the write — verify the original is the only live claim in its group.
  const orig = await sb.from("claims").select("claim_group_id").eq("id", ORIGINAL).single();
  const live = await sb
    .from("claims")
    .select("id")
    .eq("claim_group_id", orig.data!.claim_group_id as string)
    .is("deleted_at", null);
  if (live.error) throw new Error(live.error.message);
  const ids = (live.data as Array<{ id: string }>).map((r) => r.id);
  console.log(
    ids.length === 1 && ids[0] === ORIGINAL
      ? `\nVERIFIED — ${ORIGINAL.slice(0, 8)} is the only live claim in its group; its letters are untouched.`
      : `\n⚠ group still has ${ids.length} live claim(s): ${ids.map((i) => i.slice(0, 8)).join(", ")}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
