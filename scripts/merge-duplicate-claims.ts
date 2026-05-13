/**
 * One-time duplicate-claims merge — S74.5 D11 (Session 83).
 *
 * Session 81 hotfix #4 shipped display-layer dedup. The DB still carries the
 * duplicate `claims` rows. This script:
 *   1. Finds duplicate groups by composite key
 *      `(user_id, date_of_service, ROUND(total_billed*100), normalize(provider))`
 *      filtered to `deleted_at IS NULL`.
 *   2. Picks a winner per group:
 *      - most dispute_outcomes attached (preserves user work)
 *      - tiebreak by most claim_line_items (best parse fidelity)
 *      - tiebreak by most recent created_at (most recent upload)
 *   3. Redirects FKs from losers → winner:
 *      - dispute_outcomes.claim_id (SET claim_id = winner WHERE id IN losers)
 *      - claim_discrepancies.claim_id
 *      Does NOT redirect claim_line_items — the winner already has its own
 *      complete set from its own upload; losers' line items stay attached to
 *      the soft-deleted loser row (no CASCADE fires; data preserved).
 *   4. Soft-deletes losers:
 *      UPDATE claims SET deleted_at = now(), merged_into_claim_id = winner.id.
 *
 * Idempotent — re-running only operates on groups that still have ≥2 live
 * rows after prior runs.
 *
 * Run:
 *   npx tsx scripts/merge-duplicate-claims.ts            # dry-run, default
 *   npx tsx scripts/merge-duplicate-claims.ts --apply    # actually write
 *   npx tsx scripts/merge-duplicate-claims.ts --apply --user-id <uuid>   # single-user
 *
 * Loads credentials from .env.local (same pattern as scripts/seed-zero-cost-share-codes.ts).
 *
 * PRE-CONDITIONS:
 *   - migration 090 applied (adds deleted_at + merged_into_claim_id on claims)
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(__dirname, "../.env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

interface Args {
  apply: boolean;
  userId: string | null;
}

function parseArgs(): Args {
  const apply = process.argv.includes("--apply");
  const userIdx = process.argv.indexOf("--user-id");
  return {
    apply,
    userId: userIdx > -1 && process.argv[userIdx + 1] ? process.argv[userIdx + 1] : null,
  };
}

interface ClaimRow {
  id: string;
  user_id: string;
  date_of_service: string | null;
  total_billed: number | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

function normalizeProvider(name: string | undefined | null): string {
  if (!name) return "";
  return name.trim().toLowerCase();
}

function fingerprint(c: ClaimRow): string | null {
  const provider = normalizeProvider(
    (c.metadata as { provider?: { name?: string } } | null)?.provider?.name,
  );
  const totalCents = Math.round(Number(c.total_billed ?? 0) * 100);
  const date = c.date_of_service ?? "";
  if (!provider || !date || totalCents <= 0) return null;
  return `${c.user_id}|${date}|${totalCents}|${provider}`;
}

interface Stats {
  groupsFound: number;
  groupsMerged: number;
  losersProcessed: number;
  disputesRedirected: number;
  discrepanciesRedirected: number;
  losersSoftDeleted: number;
  skippedNoFingerprint: number;
  errors: number;
}

async function fetchAllLiveClaims(userIdFilter: string | null): Promise<ClaimRow[]> {
  let q = supabase
    .from("claims")
    .select("id, user_id, date_of_service, total_billed, metadata, created_at")
    .is("deleted_at", null);
  if (userIdFilter) q = q.eq("user_id", userIdFilter);
  const { data, error } = await q.order("user_id").order("created_at", { ascending: false });
  if (error) {
    console.error("[merge] fetchAllLiveClaims error:", error.message);
    return [];
  }
  return (data ?? []) as ClaimRow[];
}

async function pickWinner(group: ClaimRow[]): Promise<{ winner: ClaimRow; losers: ClaimRow[] }> {
  // Tiered selection: most disputes → most line items → most recent created.
  const ids = group.map((c) => c.id);

  const { data: disputes } = await supabase
    .from("dispute_outcomes")
    .select("claim_id")
    .in("claim_id", ids);
  const disputeCounts = new Map<string, number>();
  for (const d of disputes ?? []) {
    const cid = d.claim_id as string;
    disputeCounts.set(cid, (disputeCounts.get(cid) ?? 0) + 1);
  }

  const { data: lineItems } = await supabase
    .from("claim_line_items")
    .select("claim_id")
    .in("claim_id", ids);
  const lineCounts = new Map<string, number>();
  for (const li of lineItems ?? []) {
    const cid = li.claim_id as string;
    lineCounts.set(cid, (lineCounts.get(cid) ?? 0) + 1);
  }

  const sorted = [...group].sort((a, b) => {
    const ad = disputeCounts.get(a.id) ?? 0;
    const bd = disputeCounts.get(b.id) ?? 0;
    if (ad !== bd) return bd - ad;
    const al = lineCounts.get(a.id) ?? 0;
    const bl = lineCounts.get(b.id) ?? 0;
    if (al !== bl) return bl - al;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  return { winner: sorted[0], losers: sorted.slice(1) };
}

async function mergeGroup(
  winner: ClaimRow,
  losers: ClaimRow[],
  apply: boolean,
  stats: Stats,
): Promise<void> {
  const loserIds = losers.map((l) => l.id);

  // 1. Redirect dispute_outcomes
  const { data: disputeRows, error: dErr } = apply
    ? await supabase
        .from("dispute_outcomes")
        .update({ claim_id: winner.id })
        .in("claim_id", loserIds)
        .select("id")
    : await supabase
        .from("dispute_outcomes")
        .select("id")
        .in("claim_id", loserIds);
  if (dErr) {
    console.warn(`[merge] dispute redirect failed for winner ${winner.id}:`, dErr.message);
    stats.errors += 1;
  } else {
    stats.disputesRedirected += disputeRows?.length ?? 0;
  }

  // 2. Redirect claim_discrepancies (if table exists)
  const { data: discRows, error: discErr } = apply
    ? await supabase
        .from("claim_discrepancies")
        .update({ claim_id: winner.id })
        .in("claim_id", loserIds)
        .select("id")
    : await supabase
        .from("claim_discrepancies")
        .select("id")
        .in("claim_id", loserIds);
  if (discErr) {
    // Table may not exist in all envs; only log unexpected errors.
    if (!String(discErr.message).match(/relation .* does not exist/)) {
      console.warn(`[merge] discrepancy redirect failed for winner ${winner.id}:`, discErr.message);
      stats.errors += 1;
    }
  } else {
    stats.discrepanciesRedirected += discRows?.length ?? 0;
  }

  // 3. Soft-delete losers + write merged_into_claim_id
  if (apply) {
    for (const loser of losers) {
      const { error: softErr } = await supabase
        .from("claims")
        .update({
          deleted_at: new Date().toISOString(),
          merged_into_claim_id: winner.id,
          metadata: {
            ...(loser.metadata ?? {}),
            merged_into_claim_id: winner.id,
            merged_at: new Date().toISOString(),
            merge_reason: "duplicate_bill_upload",
          },
        })
        .eq("id", loser.id);
      if (softErr) {
        console.warn(`[merge] soft-delete failed for ${loser.id}:`, softErr.message);
        stats.errors += 1;
      } else {
        stats.losersSoftDeleted += 1;
      }
    }
  } else {
    stats.losersSoftDeleted += losers.length;
  }

  stats.losersProcessed += losers.length;
}

async function main() {
  const args = parseArgs();
  console.log(
    `[merge] mode=${args.apply ? "APPLY" : "DRY-RUN"}${args.userId ? ` user=${args.userId}` : ""}`,
  );

  const stats: Stats = {
    groupsFound: 0,
    groupsMerged: 0,
    losersProcessed: 0,
    disputesRedirected: 0,
    discrepanciesRedirected: 0,
    losersSoftDeleted: 0,
    skippedNoFingerprint: 0,
    errors: 0,
  };

  const rows = await fetchAllLiveClaims(args.userId);
  console.log(`[merge] live claims fetched: ${rows.length}`);

  const groups = new Map<string, ClaimRow[]>();
  for (const c of rows) {
    const fp = fingerprint(c);
    if (!fp) {
      stats.skippedNoFingerprint += 1;
      continue;
    }
    if (!groups.has(fp)) groups.set(fp, []);
    groups.get(fp)!.push(c);
  }

  for (const [fp, group] of groups) {
    if (group.length < 2) continue;
    stats.groupsFound += 1;
    const { winner, losers } = await pickWinner(group);
    console.log(
      `[merge] group fp=${fp.slice(0, 40)}... | size=${group.length} | winner=${winner.id} | losers=${losers.map((l) => l.id).join(",")}`,
    );
    await mergeGroup(winner, losers, args.apply, stats);
    stats.groupsMerged += 1;
  }

  console.log("");
  console.log("──────── Summary ────────");
  console.log(`mode                     ${args.apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`live claims scanned      ${rows.length}`);
  console.log(`dup groups found         ${stats.groupsFound}`);
  console.log(`groups merged            ${stats.groupsMerged}`);
  console.log(`losers processed         ${stats.losersProcessed}`);
  console.log(`disputes redirected      ${stats.disputesRedirected}`);
  console.log(`discrepancies redirected ${stats.discrepanciesRedirected}`);
  console.log(`losers soft-deleted      ${stats.losersSoftDeleted}`);
  console.log(`skipped (no fingerprint) ${stats.skippedNoFingerprint}`);
  console.log(`errors                   ${stats.errors}`);
  console.log("─────────────────────────");

  if (!args.apply) {
    console.log("");
    console.log("[merge] dry-run only — re-run with --apply to write");
  }

  process.exit(stats.errors > 0 ? 1 : 0);
}

void main();
