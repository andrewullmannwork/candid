/**
 * case-timeline DEV parity harness (Phase 0 gate, S298).
 *
 * Asserts the projector reproduces TODAY'S displayed derivations on EVERY
 * real claim in the connected DB (run against DEV; .env.local → wdpk…).
 *
 * Independence rule (calibration discipline): the "today" side is never
 * imported from the projector, which would compare the projector to itself.
 *
 * ⚠ What each comparison PROVES is no longer uniform — S303 changed one of
 * them, and saying so is the point:
 *
 *   - responseDueDate · sentLetterMeta — still true PARITY. They run the real
 *     getUserDisputes() server payload and the real client deriveSentLetterMeta(),
 *     i.e. the live surfaces, so a diff means the projector disagrees with what
 *     users see today.
 *
 *   - stage · hasNextStep — no longer parity against a live surface, because
 *     S303 moved the letter page onto the SHARED open-rung rule; no surface
 *     derives a stage independently any more. It is now a DIFFERENTIAL test: a
 *     second, hand-written implementation of the rule, run over every real
 *     claim in the DB. Still worth its keep (it catches projector regressions
 *     on real data, which synthetic fixtures cannot), but it is a regression
 *     detector, not a contract with a legacy surface. Do not "simplify" it by
 *     importing nextRungStillOpen — that would make it assert nothing.
 *
 * S303 intentional diffs, recorded before the today-side was updated (run at
 * 2026-08-04, 17 claims / 14 disputes): exactly TWO letters moved next →
 * resolved, both correctly — dispute 289b2f0c (appeal denied, its external
 * review exists and is itself lost → the case now folds) and f73262a5 (appeal
 * partially paid, its external review already drafted → the appeal is finished,
 * the case does not fold). No other stage moved.
 *
 * Compared per dispute: stage · hasNextStep · responseDueDate.
 * Compared per claim:  sentLetterMeta (responseDueDate, daysRemaining, amber).
 *
 * NON-MUTATING. Zero diffs → exit 0. Any diff → detail rows + exit 1.
 *
 * Run:  NODE_PATH=node_modules npx tsx scripts/case-timeline-dev-parity.ts
 */
import { createClient } from "@supabase/supabase-js";
import { loadScriptEnv } from "./_env";
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

const env = loadScriptEnv();
const sb = createClient(env.url, env.serviceRoleKey);

// letterType: since the S298 consolidation the display path and the projector
// IMPORT THE SAME resolver (src/lib/disputes/letter-type.ts), so this input is
// shared by construction — the parity signal lives in the stage machine, the
// responseDueDate math, and sentLetterMeta, which remain independently derived
// on the "today" side below.
import { resolveLetterTypeFromDispute as todayLetterType } from "../src/lib/disputes/letter-type";

(async () => {

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
      // S303 — the open-rung rule, hand-written here rather than imported, so
      // this stays a second independent implementation rather than a comparison
      // of the projector to itself. Mirrors nextRungStillOpen: the ladder must
      // offer a rung AND no other live letter on the claim may already be it.
      const rawNext = detail
        ? suggestNextStep(todayLetterType(d) as DisputeLetterType, detail)
        : null;
      const todayHasNext =
        rawNext != null &&
        !claimDisputes.some(
          (x) =>
            x.id !== d.id &&
            todayLetterType(x) === rawNext.nextLetterType &&
            x.status !== "cancelled",
        );
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
