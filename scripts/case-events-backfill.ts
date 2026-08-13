/**
 * claim_case_events backfill (Phase 0, S298, mig 221).
 *
 * Synthesizes history events for EXISTING claims/disputes from row timestamps
 * — via the projector's shared synthesizeCaseEventsFromRows(), so backfilled
 * rows and the projector's virtual union are the SAME derivation and can never
 * disagree. Writes actor='backfill'; the mig-221 partial unique index makes
 * re-runs idempotent (duplicate-key rejections are counted as "already").
 *
 * Deliberately NOT backfilled (same exclusions as synthesis):
 * deadline_lapsed (cron owns the judgment — its sweep emits for already-lapsed
 * disputes on the first flag-ON run) · dispute-checklist attests (no
 * timestamps) · followup_sent (no send moments stored).
 *
 * DRY-RUN by default; pass --write to persist. Writes go through userScoped
 * (per-claim user_id) like every other claim_case_events write.
 *
 * ⚠ TARGET: whichever database `.env.local` points at (DEV by default; PROD
 * after `./scripts/use-db.sh prod`). The banner names it on every run, and a
 * PROD --write additionally requires --prod-write (S313) — this script writes
 * real user history rows, so the target must be a decision, not a leftover.
 *
 * Run:  npx tsx scripts/case-events-backfill.ts                        (dry-run)
 *       npx tsx scripts/case-events-backfill.ts --write                (DEV)
 *       npx tsx scripts/case-events-backfill.ts --write --prod-write   (PROD)
 */
import { createClient } from "@supabase/supabase-js";
import {
  synthesizeCaseEventsFromRows,
  type ProjectorClaimRow,
  type ProjectorDisputeRow,
} from "../src/lib/case/timeline-projector";
import { userScoped } from "../src/lib/security/user-scoped";
import { loadScriptEnv, requireWriteAck } from "./_env";

const env = loadScriptEnv();
const sb = createClient(env.url, env.serviceRoleKey);
const WRITE = process.argv.includes("--write");
requireWriteAck(env, WRITE);

(async () => {
  console.log("MODE:", WRITE ? "WRITE" : "dry-run (pass --write to persist)");

  const { data: claims, error: cErr } = await sb
    .from("claims")
    .select("id, user_id, created_at, metadata")
    .is("deleted_at", null);
  if (cErr) {
    console.error("claims load failed:", JSON.stringify(cErr));
    process.exit(1);
  }
  const { data: disputes, error: dErr } = await sb
    .from("dispute_outcomes")
    .select(
      "id, claim_id, dispute_type, status, created_at, filed_date, resolution_date, sent_at, governing_deadline_date, deadline_type, metadata",
    );
  if (dErr) {
    console.error("disputes load failed:", JSON.stringify(dErr));
    process.exit(1);
  }

  const byKind = new Map<string, number>();
  let total = 0;
  let written = 0;
  let already = 0;
  let errors = 0;

  for (const claim of claims ?? []) {
    const claimRow: ProjectorClaimRow = {
      id: claim.id as string,
      created_at: claim.created_at as string,
      metadata: (claim.metadata as Record<string, unknown> | null) ?? null,
    };
    const claimDisputes = (disputes ?? []).filter(
      (d) => d.claim_id === claim.id,
    ) as unknown as ProjectorDisputeRow[];
    const synth = synthesizeCaseEventsFromRows(claimRow, claimDisputes);
    for (const s of synth) {
      total++;
      byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);
      if (!WRITE) continue;
      // One row per insert: the idempotency index is partial+expression-based,
      // so PostgREST upsert can't target it — a 23505 IS the "already done"
      // signal. Per-row keeps one duplicate from failing a whole batch.
      const { error } = await userScoped(sb, claim.user_id as string)
        .table("claim_case_events")
        .insert({
          claim_id: s.claimId,
          dispute_id: s.disputeId,
          kind: s.kind,
          actor: "backfill",
          occurred_at: s.occurredAt,
          payload: s.payload,
        });
      if (!error) written++;
      else if (error.code === "23505") already++;
      else {
        errors++;
        console.error(`insert failed (${s.kind} claim ${s.claimId}):`, JSON.stringify(error));
      }
    }
  }

  console.log(`\nsynthesized: ${total} events across ${claims?.length ?? 0} claims`);
  for (const [k, n] of [...byKind.entries()].sort()) console.log(`  ${k}: ${n}`);
  if (WRITE) {
    console.log(`written: ${written} · already-present: ${already} · errors: ${errors}`);
    if (errors > 0) {
      console.log("BACKFILL COMPLETED WITH ERRORS ✗");
      process.exit(1);
    }
    console.log("BACKFILL COMPLETE ✓");
  } else {
    console.log("dry-run only — nothing written");
  }
})();
