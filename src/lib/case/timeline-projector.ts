/**
 * timeline-projector — ONE derivation of a claim's case timeline (Phase 0, S298).
 *
 * Composes mutable rows (current-state authority) + `claim_case_events`
 * (history/sequence authority, mig 221) into the projected case model the
 * extended rail will render (agenda §1: claim GET and dispute GET read ONLY
 * this — the one-derivation enforcement point; S297's `deriveSentLetterMeta`
 * folds in here rather than drifting beside it).
 *
 * PURE: no IO, no clock — `now` is an input, so fixtures and the parity
 * harness are deterministic. Phase 0 has ZERO UI consumers; the parity
 * harness + fixtures are the only readers until phase 1 wires the rail.
 *
 * Parity contract (Phase-0 gate) — reproduces byte-for-byte the derivations
 * today's surfaces display:
 *   - stage:            computeCaseStage(status, !!sent_at, hasNextStep)
 *                       where hasNextStep mirrors the dispute page (S266):
 *                       isOutcomeDetail(metadata.outcomeDetail)
 *                         ? suggestNextStep(letterType, outcomeDetail) != null
 *                         : false
 *   - responseDueDate:  governing_deadline_date ?? sent_at + 30d (date-only)
 *                       — persist.ts getUserDisputes, verbatim semantics
 *   - sentLetterMeta:   deriveSentLetterMeta (use-claim-pipeline) semantics —
 *                       sent + non-cancelled, earliest due, ceil-days, amber
 *
 * `synthesizeCaseEventsFromRows` is exported as the SHARED row→event
 * derivation: the projector unions it under real events (so pre-mig and
 * flag-OFF periods still render history), and the backfill script writes
 * exactly its output (actor "backfill") — one derivation, two consumers, so
 * backfilled rows and virtual rows can never disagree. Dedupe is by exact
 * (kind, disputeId, occurred_at): a backfilled event and its virtual twin
 * collapse to one.
 */
import {
  computeCaseStage,
  type CaseStage,
} from "@/lib/disputes/case-stage";
import {
  isOutcomeDetail,
  suggestNextStep,
  type OutcomeDetail,
} from "@/lib/disputes/outcome-taxonomy";
import { letterRecipientKind, type LetterRecipientKind } from "@/lib/disputes";
import { resolveLetterTypeFromDispute } from "@/lib/disputes/letter-type";
import type { DisputeLetterType } from "@/lib/billing/types";
import type { CaseEventKind, CaseEventActor } from "@/lib/case/case-events";

// ── Inputs (narrow row projections — callers select these columns) ──────────

export interface ProjectorDisputeRow {
  id: string;
  claim_id: string | null;
  dispute_type: string;
  status: string;
  created_at: string;
  filed_date: string | null;
  resolution_date: string | null;
  sent_at: string | null;
  governing_deadline_date: string | null;
  deadline_type: string | null;
  metadata: Record<string, unknown> | null;
}

export interface ProjectorClaimRow {
  id: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

export interface ProjectorEventRow {
  dispute_id: string | null;
  kind: string;
  actor: string;
  occurred_at: string;
  payload: Record<string, unknown> | null;
}

export interface ProjectTimelineInput {
  claim: ProjectorClaimRow;
  disputes: ProjectorDisputeRow[];
  events: ProjectorEventRow[];
  /** The clock, injected — fixtures/parity pass a fixed instant. */
  now: Date;
  /** guided_steps_v1.config.sent_countdown_amber_days (default 7). */
  amberDays: number;
}

// ── Output model ────────────────────────────────────────────────────────────

export interface ProjectedHistoryEntry {
  kind: CaseEventKind | string;
  actor: CaseEventActor | string;
  occurredAt: string;
  disputeId: string | null;
  payload: Record<string, unknown>;
  /** True when this entry came from row synthesis, not a stored event. */
  virtual: boolean;
}

export interface ProjectedLetterStep {
  disputeId: string;
  /** Render letter type (metadata.letterType, legacy rows reverse-mapped). */
  letterType: string;
  recipientKind: LetterRecipientKind;
  /** Chronological anchor — the step's start event (row birth). */
  startAt: string;
  stage: CaseStage;
  hasNextStep: boolean;
  latestSendAt: string | null;
  sendCount: number;
  unsendCount: number;
  redraftCount: number;
  /** Parity-exact responseDueDate (governing ?? sent+30d, date-only). */
  responseDueDate: string | null;
  deadlineType: string | null;
  outcome: { detail: OutcomeDetail; status: string; loggedAt: string | null } | null;
}

export interface ProjectedSentLetterMeta {
  responseDueDate: string | null;
  daysRemaining: number | null;
  amber: boolean;
}

export interface ProjectedCaseTimeline {
  claimId: string;
  /** Chronological (startAt ascending; stable on ties by disputeId). */
  letters: ProjectedLetterStep[];
  /** Letters in stage "awaiting" — sent, no outcome, no next step offered. */
  waitingCount: number;
  /** Soonest responseDueDate among awaiting letters. */
  soonestResponseDue: { date: string; disputeId: string } | null;
  /** Parity-exact fold of deriveSentLetterMeta (null when nothing sent). */
  sentLetterMeta: ProjectedSentLetterMeta | null;
  /** Merged history: stored events ∪ row synthesis, deduped, ascending. */
  history: ProjectedHistoryEntry[];
}

// ── Letter-type resolution ──────────────────────────────────────────────────

/**
 * ONE resolver for all consumers (S298, Andrew: "fix it now") — the shared
 * resolveLetterTypeFromDispute in src/lib/disputes/letter-type.ts, also
 * imported by the [disputeId] GET and the redraft route (whose private copies
 * had drifted from each other). Includes the corrected legacy mapping
 * (external_appeal → external_review). Parity holds by construction: the
 * display path and the projector now share the derivation.
 */
export function resolveLetterType(d: ProjectorDisputeRow): string {
  return resolveLetterTypeFromDispute(d);
}

// ── Shared row→event synthesis (projector virtual union + backfill writes) ──

export interface SynthesizedCaseEvent {
  claimId: string;
  disputeId: string | null;
  kind: CaseEventKind;
  occurredAt: string;
  payload: Record<string, unknown>;
}

const PHONE_OUTCOME_STEP_ID = "packA:phone-outcome";

/**
 * Derive the events the rows still remember. Deliberately NOT synthesized:
 *   - deadline_lapsed (the cron sweep owns that judgment — first flag-ON run
 *     emits for already-lapsed disputes; synthesizing here = two truths)
 *   - dispute-side checklist attests (booleans carry no timestamps — S297
 *     known gap, agenda §6.5)
 *   - followup_sent (dispute_followups tracks status, not send moments)
 * Ordering inside equal timestamps is resolved at merge time, not here.
 */
export function synthesizeCaseEventsFromRows(
  claim: ProjectorClaimRow,
  disputes: ProjectorDisputeRow[],
): SynthesizedCaseEvent[] {
  const out: SynthesizedCaseEvent[] = [];
  const claimId = claim.id;

  for (const d of disputes) {
    const meta = d.metadata ?? {};
    const letterType = resolveLetterType(d);

    out.push({
      claimId,
      disputeId: d.id,
      kind: "letter_drafted",
      occurredAt: d.created_at,
      payload: { letterType },
    });

    const redrafts = Array.isArray(meta.redraftHistory)
      ? (meta.redraftHistory as unknown[]).filter(
          (t): t is string => typeof t === "string" && t.length > 0,
        )
      : [];
    for (const t of redrafts) {
      out.push({
        claimId,
        disputeId: d.id,
        kind: "letter_redrafted",
        occurredAt: t,
        payload: { letterType },
      });
    }

    if (d.sent_at) {
      out.push({
        claimId,
        disputeId: d.id,
        kind: "letter_sent",
        occurredAt: d.sent_at,
        payload: { letterType },
      });
    }

    const outcomeDetail =
      typeof meta.outcomeDetail === "string" && isOutcomeDetail(meta.outcomeDetail)
        ? meta.outcomeDetail
        : null;
    const outcomeReportedAt =
      typeof meta.outcomeReportedAt === "string" ? meta.outcomeReportedAt : null;
    if (outcomeDetail && outcomeReportedAt) {
      out.push({
        claimId,
        disputeId: d.id,
        kind: outcomeDetail === "collections" ? "collections_reported" : "response_logged",
        occurredAt: outcomeReportedAt,
        payload: { outcomeDetail, status: d.status },
      });
    }

    const escalatedFrom =
      typeof meta.escalatedFromDisputeId === "string" ? meta.escalatedFromDisputeId : null;
    if (escalatedFrom) {
      out.push({
        claimId,
        disputeId: escalatedFrom,
        kind: "escalated",
        occurredAt: d.created_at,
        payload: { toDisputeId: d.id, targetLetterType: letterType },
      });
    }

    if (letterType === "debt_validation") {
      out.push({
        claimId,
        disputeId: d.id,
        kind: "collections_reported",
        occurredAt: d.created_at,
        payload: {
          hasCollector: typeof meta.collector === "object" && meta.collector != null,
          hasFirstContactDate: typeof meta.collectorFirstContactDate === "string",
        },
      });
    }
  }

  const guideSteps =
    ((claim.metadata ?? {}).guideSteps as
      | Record<string, { checkedAt?: string | null; note?: string }>
      | undefined) ?? {};
  for (const [stepId, row] of Object.entries(guideSteps)) {
    if (typeof row?.checkedAt !== "string" || row.checkedAt.length === 0) continue;
    if (stepId === PHONE_OUTCOME_STEP_ID) {
      const answer =
        typeof row.note === "string" && ["yes", "no", "skip"].includes(row.note)
          ? row.note
          : null;
      out.push({
        claimId,
        disputeId: null,
        kind: "phone_outcome_answered",
        occurredAt: row.checkedAt,
        payload: { stepId, answer },
      });
    } else {
      out.push({
        claimId,
        disputeId: null,
        kind: "guide_step_attested",
        occurredAt: row.checkedAt,
        payload: {
          stepId,
          hasNote: typeof row.note === "string" && row.note.length > 0,
        },
      });
    }
  }

  return out;
}

// ── Parity-exact per-letter derivations ─────────────────────────────────────

/** persist.ts getUserDisputes responseDueDate, verbatim semantics. */
export function deriveResponseDueDate(d: ProjectorDisputeRow): string | null {
  if (d.governing_deadline_date) return d.governing_deadline_date;
  if (!d.sent_at) return null;
  const t = Date.parse(d.sent_at);
  if (Number.isNaN(t)) return null;
  return new Date(t + 30 * 86_400_000).toISOString().slice(0, 10);
}

function projectLetterStep(d: ProjectorDisputeRow): ProjectedLetterStep {
  const meta = d.metadata ?? {};
  const letterType = resolveLetterType(d);
  const outcomeDetail =
    typeof meta.outcomeDetail === "string" && isOutcomeDetail(meta.outcomeDetail)
      ? meta.outcomeDetail
      : null;
  // Dispute page (S266): the escalate CTA exists only once an outcome is
  // logged and the taxonomy offers a next rung for this letter type.
  const hasNextStep = outcomeDetail
    ? suggestNextStep(letterType as DisputeLetterType, outcomeDetail) != null
    : false;
  return {
    disputeId: d.id,
    letterType,
    recipientKind: letterRecipientKind(letterType),
    startAt: d.created_at,
    stage: computeCaseStage({
      status: d.status,
      isSent: d.sent_at != null,
      hasNextStep,
    }),
    hasNextStep,
    latestSendAt: d.sent_at,
    sendCount: 0, // filled from merged history below
    unsendCount: 0,
    redraftCount: 0,
    responseDueDate: deriveResponseDueDate(d),
    deadlineType: d.deadline_type,
    outcome: outcomeDetail
      ? {
          detail: outcomeDetail,
          status: d.status,
          loggedAt:
            typeof meta.outcomeReportedAt === "string" ? meta.outcomeReportedAt : null,
        }
      : null,
  };
}

// ── The projector ───────────────────────────────────────────────────────────

export function projectCaseTimeline(input: ProjectTimelineInput): ProjectedCaseTimeline {
  const { claim, disputes, events, now, amberDays } = input;
  const claimDisputes = disputes.filter((d) => d.claim_id === claim.id);

  // Merged history — stored events win over their virtual twins on the exact
  // (kind, disputeId, occurredAt) key; ascending, ties broken kind-stable.
  const stored: ProjectedHistoryEntry[] = events.map((e) => ({
    kind: e.kind,
    actor: e.actor,
    occurredAt: e.occurred_at,
    disputeId: e.dispute_id,
    payload: e.payload ?? {},
    virtual: false,
  }));
  const seen = new Set(
    stored.map((e) => `${e.kind}|${e.disputeId ?? ""}|${normalizeTs(e.occurredAt)}`),
  );
  const virtual: ProjectedHistoryEntry[] = synthesizeCaseEventsFromRows(claim, claimDisputes)
    .filter((s) => !seen.has(`${s.kind}|${s.disputeId ?? ""}|${normalizeTs(s.occurredAt)}`))
    .map((s) => ({
      kind: s.kind,
      actor: "backfill",
      occurredAt: s.occurredAt,
      disputeId: s.disputeId,
      payload: s.payload,
      virtual: true,
    }));
  const history = [...stored, ...virtual].sort(
    (a, b) =>
      normalizeTs(a.occurredAt) - normalizeTs(b.occurredAt) ||
      a.kind.localeCompare(b.kind),
  );

  // Letters — rows are the current-state authority; history fills counts.
  const letters = claimDisputes
    .map(projectLetterStep)
    .sort(
      (a, b) =>
        normalizeTs(a.startAt) - normalizeTs(b.startAt) ||
        a.disputeId.localeCompare(b.disputeId),
    );
  const byDispute = new Map(letters.map((l) => [l.disputeId, l]));
  for (const e of history) {
    if (!e.disputeId) continue;
    const l = byDispute.get(e.disputeId);
    if (!l) continue;
    if (e.kind === "letter_sent") l.sendCount += 1;
    else if (e.kind === "letter_unsent") l.unsendCount += 1;
    else if (e.kind === "letter_redrafted") l.redraftCount += 1;
  }

  const awaiting = letters.filter((l) => l.stage === "awaiting");
  const soonest =
    awaiting
      .filter((l) => l.responseDueDate != null)
      .sort((a, b) => (a.responseDueDate! < b.responseDueDate! ? -1 : 1))[0] ?? null;

  return {
    claimId: claim.id,
    letters,
    waitingCount: awaiting.length,
    soonestResponseDue: soonest
      ? { date: soonest.responseDueDate!, disputeId: soonest.disputeId }
      : null,
    sentLetterMeta: deriveSentLetterMetaParity(claimDisputes, now, amberDays),
    history,
  };
}

/**
 * deriveSentLetterMeta (use-claim-pipeline) with the clock injected — same
 * filter (sent + non-cancelled), same earliest-due (string sort), same
 * ceil-days, same amber threshold. The parity harness asserts equality
 * against the client export on every real DEV claim.
 */
export function deriveSentLetterMetaParity(
  disputes: ProjectorDisputeRow[],
  now: Date,
  amberDays: number,
): ProjectedSentLetterMeta | null {
  const sent = disputes.filter((d) => d.status !== "cancelled" && d.sent_at != null);
  if (sent.length === 0) return null;
  const due =
    sent
      .map(deriveResponseDueDate)
      .filter((x): x is string => typeof x === "string" && x.length > 0)
      .sort()[0] ?? null;
  if (!due) return { responseDueDate: null, daysRemaining: null, amber: false };
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(due) ? `${due}T00:00:00` : due);
  if (Number.isNaN(t)) return { responseDueDate: due, daysRemaining: null, amber: false };
  const daysRemaining = Math.ceil((t - now.getTime()) / 86_400_000);
  return { responseDueDate: due, daysRemaining, amber: daysRemaining <= amberDays };
}

function normalizeTs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}
