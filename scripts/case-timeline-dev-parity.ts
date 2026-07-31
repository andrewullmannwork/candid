/**
 * case-timeline DEV parity harness (Phase 0 gate, S298).
 *
 * Asserts the projector reproduces TODAY'S displayed derivations on EVERY
 * real claim in the connected DB (run against DEV; .env.local → wdpk…).
 *
 * Independence rule (calibration discipline): the "today" side is computed by
 * the SAME code paths today's surfaces use — the real getUserDisputes() server
 * payload, the real client deriveSentLetterMeta(), computeCaseStage() fed the
 * dispute page's way, and the [disputeId] GET's letterType switch copied
 * VERBATIM inline (not imported from the projector, which would compare the
 * projector to itself).
 *
 * Compared per dispute: stage · hasNextStep · responseDueDate.
 * Compared per claim:  sentLetterMeta (responseDueDate, daysRemaining, amber).
 *
 * NON-MUTATING. Zero diffs → exit 0. Any diff → detail rows + exit 1.
 *
 * Run:  NODE_PATH=node_modules npx tsx scripts/case-timeline-dev-parity.ts
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import {
  projectCaseTimeline,
  type ProjectorClaimRow,
  type ProjectorDisputeRow,
  type ProjectorEventRow,
} from "../src/lib/case/timeline-projector";
import { computeCaseStage } from "../src/lib/disputes/case-stage";
import {
  isOutcomeDetail,
  suggestNextStep,
} from "../src/lib/disputes/outcome-taxonomy";
import { getUserDisputes } from "../src/lib/disputes/persist";
import { deriveSentLetterMeta } from "../src/lib/claims/use-claim-pipeline";
import type { DisputeLetterType } from "../src/lib/billing/types";

config({ path: ".env.local" });
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// VERBATIM copy of resolveLetterTypeFromDispute ([disputeId]/route.ts:963) —
// the display path's own derivation, kept independent of the projector.
function todayLetterType(d: { dispute_type: string; metadata: Record<string, unknown> | null }): string {
  const metaType =
    d.metadata && typeof d.metadata === "object"
      ? (d.metadata as { letterType?: string }).letterType
      : undefined;
  if (metaType) return metaType;
  switch (d.dispute_type) {
    case "internal_appeal":
      return "insurance_appeal";
    case "negotiation":
      return "negotiation";
    case "complaint":
      return "balance_billing";
    case "external_appeal":
      return "insurance_appeal";
    default:
      return "overcharge";
  }
}

(async () => {
  console.log("PROJECT:", process.env.NEXT_PUBLIC_SUPABASE_URL);

  // amberDays exactly as the outcome route reads it (config key, default 7).
  const { data: flagRow } = await sb
    .from("feature_flag_rules")
    .select("config")
    .eq("flag_key", "guided_steps_v1")
    .maybeSingle();
  const rawAmber = (flagRow?.config as Record<string, unknown> | null)?.sent_countdown_amber_days;
  const amberDays = typeof rawAmber === "number" && Number.isFinite(rawAmber) ? rawAmber : 7;

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
      "id, claim_id, user_id, dispute_type, status, created_at, filed_date, resolution_date, sent_at, governing_deadline_date, deadline_type, metadata",
    );
  if (dErr) {
    console.error("disputes load failed:", JSON.stringify(dErr));
    process.exit(1);
  }
  const { data: events, error: eErr } = await sb
    .from("claim_case_events")
    .select("claim_id, dispute_id, kind, actor, occurred_at, payload");
  if (eErr) {
    console.error("events load failed:", JSON.stringify(eErr));
    process.exit(1);
  }

  // Real server payload per user → the client meta derivation, per claim.
  const userIds = [...new Set((claims ?? []).map((c) => c.user_id as string))];
  const serverPayloadByUser = new Map<string, Awaited<ReturnType<typeof getUserDisputes>>>();
  for (const uid of userIds) {
    serverPayloadByUser.set(uid, await getUserDisputes(sb, uid));
  }

  const NOW = new Date();
  let checkedClaims = 0;
  let checkedDisputes = 0;
  const diffs: string[] = [];

  for (const claim of claims ?? []) {
    const claimRow: ProjectorClaimRow = {
      id: claim.id as string,
      created_at: claim.created_at as string,
      metadata: (claim.metadata as Record<string, unknown> | null) ?? null,
    };
    const claimDisputes = (disputes ?? []).filter((d) => d.claim_id === claim.id);
    const claimEvents: ProjectorEventRow[] = (events ?? [])
      .filter((e) => e.claim_id === claim.id)
      .map((e) => ({
        dispute_id: e.dispute_id as string | null,
        kind: e.kind as string,
        actor: e.actor as string,
        occurred_at: e.occurred_at as string,
        payload: (e.payload as Record<string, unknown> | null) ?? {},
      }));

    const projected = projectCaseTimeline({
      claim: claimRow,
      disputes: claimDisputes as unknown as ProjectorDisputeRow[],
      events: claimEvents,
      now: NOW,
      amberDays,
    });
    checkedClaims++;

    // Per-dispute: stage + hasNextStep + responseDueDate.
    const serverPayload = serverPayloadByUser.get(claim.user_id as string);
    for (const d of claimDisputes) {
      checkedDisputes++;
      const md = (d.metadata as Record<string, unknown> | null) ?? {};
      const detail = isOutcomeDetail(md.outcomeDetail) ? md.outcomeDetail : null;
      const todayHasNext = detail
        ? suggestNextStep(todayLetterType(d) as DisputeLetterType, detail) != null
        : false;
      const todayStage = computeCaseStage({
        status: d.status as string,
        isSent: d.sent_at != null,
        hasNextStep: todayHasNext,
      });
      const todayDue =
        serverPayload?.disputes.find((x) => x.id === d.id)?.responseDueDate ?? null;

      const mine = projected.letters.find((l) => l.disputeId === d.id);
      if (!mine) {
        diffs.push(`claim ${claim.id} dispute ${d.id}: MISSING from projection`);
        continue;
      }
      if (mine.stage !== todayStage) {
        diffs.push(`dispute ${d.id}: stage ${mine.stage} ≠ today ${todayStage}`);
      }
      if (mine.hasNextStep !== todayHasNext) {
        diffs.push(`dispute ${d.id}: hasNextStep ${mine.hasNextStep} ≠ today ${todayHasNext}`);
      }
      if (mine.responseDueDate !== todayDue) {
        diffs.push(`dispute ${d.id}: responseDueDate ${mine.responseDueDate} ≠ today ${todayDue}`);
      }
    }

    // Per-claim: sentLetterMeta vs the REAL client derivation on the REAL
    // server payload (the exact /claim data path).
    const clientMeta = serverPayload
      ? deriveSentLetterMeta(serverPayload.disputes, claim.id as string, amberDays)
      : null;
    const mineMeta = projected.sentLetterMeta;
    const same =
      (clientMeta === null && mineMeta === null) ||
      (clientMeta != null &&
        mineMeta != null &&
        clientMeta.responseDueDate === mineMeta.responseDueDate &&
        clientMeta.amber === mineMeta.amber &&
        clientMeta.daysRemaining === mineMeta.daysRemaining);
    if (!same) {
      diffs.push(
        `claim ${claim.id}: sentLetterMeta ${JSON.stringify(mineMeta)} ≠ today ${JSON.stringify(clientMeta)}`,
      );
    }
  }

  console.log(
    `\ncase-timeline DEV parity: ${checkedClaims} claims · ${checkedDisputes} disputes · amberDays=${amberDays} · ${diffs.length} diffs`,
  );
  if (diffs.length) {
    console.log(diffs.slice(0, 50).join("\n"));
    if (diffs.length > 50) console.log(`… and ${diffs.length - 50} more`);
    console.log("PARITY FAILED ✗");
    process.exit(1);
  }
  console.log("PARITY HOLDS ✓");
})();
