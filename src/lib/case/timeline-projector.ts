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
 *                       ⚠ S303 CHANGED THIS, deliberately and with the diffs
 *                       recorded (scripts/case-timeline-dev-parity.ts header).
 *                       hasNextStep is no longer "does the ladder offer a rung"
 *                       — it is nextRungStillOpen: the ladder offers one AND no
 *                       other live letter on the claim already IS it. The old
 *                       reading left every escalated-to-the-end case stuck at
 *                       `next` forever, so it could never resolve and the rail
 *                       could never fold. The dispute page runs the same shared
 *                       rule, so the two surfaces still agree by construction.
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
  nextRungStillOpen,
  type CaseLetterRef,
  type OutcomeDetail,
} from "@/lib/disputes/outcome-taxonomy";
import { letterRecipientKind, type LetterRecipientKind } from "@/lib/disputes";
import { resolveLetterTypeFromDispute } from "@/lib/disputes/letter-type";
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
  /** S302 — what the user logged as recovered on this letter; the resolved
   *  fold sums it across the case. NUMERIC comes back as a number or a
   *  string depending on the driver, so consumers coerce. */
  amount_recovered?: number | string | null;
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
  // ── S299 phase-1a additive display fields. Deliberately NO day-counts here:
  // the projector runs server-side (UTC on Vercel), and calendars belong to
  // the USER's timezone — day-math lives client-side in rail-steps via the
  // shared letter-type.ts date rule (the S299 "sent Jul 31 vs Jul 30" lesson).
  /** Collector display name (metadata.collector.name) on collector letters; null otherwise. */
  counterpartyName: string | null;
  /**
   * S301 — collections guard-rail step state for THIS letter, read from the
   * claim-scoped `claims.metadata.guideSteps`. Collector letters only; `{}`
   * otherwise.
   *
   * Lives on the projection rather than being threaded to the rail as a
   * separate prop, for the same reason `mailedCertified` and `regulatorFiled`
   * already do: the rail then has ONE input. The first cut passed it beside the
   * projection instead, CaseRail forgot to forward it, and every collections
   * step sat permanently "open" while the writes landed perfectly. A prop that
   * does not exist cannot be dropped.
   */
  collectionsSteps: Record<
    string,
    { checkedAt: string | null; skippedAt: string | null; note: string | null }
  >;
  /**
   * S301 — the collector's first-contact date (metadata.collectorFirstContactDate),
   * date-only, on collector letters; null otherwise. The FDCPA §1692g anchor.
   * Surfaced so the rail's "When did they first contact you?" step can PREFILL
   * the date already on file instead of showing an empty field — and so the
   * projector stays the one derivation the rail reads (it already emits
   * `hasFirstContactDate` into the collections_reported event from this value).
   */
  collectorFirstContactDate: string | null;
  /**
   * Dispute-side "Mail it certified" attest (metadata.checklist.mailcert === true).
   * Genuinely per-letter — each letter is mailed on its own. Contrast the
   * regulator complaint, which is an act against the BILL and therefore lives
   * on the case (see {@link ProjectedCaseTimeline.regulator}).
   */
  mailedCertified: boolean;
  outcome: { detail: OutcomeDetail; status: string; loggedAt: string | null } | null;
  /**
   * S302 — dollars this letter recovered, as the user logged them. Null when
   * unlogged or unparseable; NEVER 0-as-unknown, so the resolved fold can tell
   * "recovered nothing" from "never said".
   */
  amountRecovered: number | null;
}

export interface ProjectedSentLetterMeta {
  responseDueDate: string | null;
  daysRemaining: number | null;
  amber: boolean;
}

/** One attested regulator filing: which agency, about which letter, when. */
export interface ProjectedRegulatorFiling {
  /** COMPLAINT_DOORS id — doi / ag / cfpb / cms. */
  doorId: string;
  /** The letter whose outcome this complaint was filed in response to. */
  disputeId: string;
  filedAt: string;
  /** The confirmation number the agency handed back. */
  note: string | null;
}

/**
 * The regulator complaints on a case (S303, Andrew).
 *
 * ⚠ Read the scoping carefully, because it is split deliberately:
 *
 *   The NUMBERS are linked; the BEHAVIOUR is per letter.
 *
 * A complaint is filed in response to ONE letter's outcome — a denied appeal
 * and a collector refusing to validate are two wrongs by two parties, and
 * answering the first does not answer the second. So each filing carries the
 * letter it was made about, and "have I taken my next move on THIS letter" is
 * asked again for every letter. What is shared is the RECORD: a confirmation
 * number logged on the appeal is visible on every later card, marked as
 * belonging to that earlier letter, so the user can see it and still file
 * again if the new wrong warrants it.
 *
 * What was actually broken before S303 (the scope was not): one bare boolean
 * per dispute stood for four possible agencies, so "filed" could not say with
 * WHOM; the three cards rendered the same question with no letter attribution
 * and different answers; and the declination did not persist at all.
 *
 * Everything lives in `claims.metadata.guideSteps` with the letter in the key,
 * rather than on the dispute checklist which is letter-scoped by nature. That
 * store holds BARE BOOLEANS — no timestamps, no skip, no note versioning — so
 * building there would mean porting all three onto it, i.e. growing a second
 * attestation store with parallel features. One store, one set of guarantees:
 * server-stamped times, `checkedAt`/`skippedAt` mutually exclusive on write,
 * `noteHistory` banking, and ledger events, all already built.
 *
 * No migration: Pack D has never shipped to production.
 */
export interface ProjectedRegulatorComplaint {
  /** Every filing on the case, ascending by filedAt (ties stable by key). */
  filings: ProjectedRegulatorFiling[];
  /**
   * disputeId → when the user declined to file about THAT letter. Per letter,
   * so declining on the collector cannot touch what was recorded against the
   * appeal. Deliberately never a flavour of filed (S297 §3.2): these
   * attestations feed the recital and the flywheel, so "I chose not to" and
   * "I did" must stay distinguishable in the DATA, not just in the colour.
   */
  declinedByDispute: Record<string, string>;
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
  /**
   * S303 — the case-level regulator complaint. NEVER null: an empty record is
   * "nothing filed yet", which readers must handle anyway, so a nullable field
   * would only add a second way to say the same thing (S301: an optional field
   * is what lets a gap compile).
   */
  regulator: ProjectedRegulatorComplaint;
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

function projectLetterStep(
  d: ProjectorDisputeRow,
  claimGuideSteps: Record<string, { checkedAt?: string | null; skippedAt?: string | null; note?: string }>,
  caseLetters: CaseLetterRef[],
): ProjectedLetterStep {
  const meta = d.metadata ?? {};
  const letterType = resolveLetterType(d);
  const recipientKind = letterRecipientKind(letterType);
  const outcomeDetail =
    typeof meta.outcomeDetail === "string" && isOutcomeDetail(meta.outcomeDetail)
      ? meta.outcomeDetail
      : null;
  // S303 — a rung STILL TO TAKE, not merely one the ladder offers. Asking the
  // weaker question left every escalated-to-the-end case stuck at `next`
  // forever, so it could never resolve and the rail could never fold. The rule
  // lives in the taxonomy because three surfaces ask it; see nextRungStillOpen.
  const hasNextStep =
    nextRungStillOpen({
      disputeId: d.id,
      letterType,
      outcomeDetail,
      caseLetters,
    }) != null;
  const collector = meta.collector as { name?: unknown } | null | undefined;
  const checklist = meta.checklist as Record<string, unknown> | null | undefined;
  return {
    disputeId: d.id,
    letterType,
    recipientKind,
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
    counterpartyName:
      recipientKind === "collector" &&
      collector != null &&
      typeof collector === "object" &&
      typeof collector.name === "string" &&
      collector.name.length > 0
        ? collector.name
        : null,
    // S301 — same guard as counterpartyName: collector letters only, so a
    // provider or insurer rung can never surface collections state.
    collectionsSteps:
      recipientKind === "collector"
        ? Object.fromEntries(
            Object.entries(claimGuideSteps)
              .filter(([k]) => k.startsWith("packC:"))
              .map(([k, v]) => [
                k,
                {
                  checkedAt: typeof v?.checkedAt === "string" ? v.checkedAt : null,
                  skippedAt: typeof v?.skippedAt === "string" ? v.skippedAt : null,
                  note: typeof v?.note === "string" ? v.note : null,
                },
              ]),
          )
        : {},
    collectorFirstContactDate:
      recipientKind === "collector" && typeof meta.collectorFirstContactDate === "string"
        ? meta.collectorFirstContactDate
        : null,
    mailedCertified: checklist != null && checklist.mailcert === true,
    outcome: outcomeDetail
      ? {
          detail: outcomeDetail,
          status: d.status,
          loggedAt:
            typeof meta.outcomeReportedAt === "string" ? meta.outcomeReportedAt : null,
        }
      : null,
    amountRecovered: coerceAmount(d.amount_recovered),
  };
}

/**
 * `packD:filed:<disputeId>:<doorId>` — one attested filing, per agency, per
 * letter. `packD:skip:<disputeId>` — that letter's declination.
 *
 * BUILT here, not spelled out at the call sites: the rail WRITES these keys
 * and the projector READS them, and two string literals a file apart is
 * exactly how the packC:first-contact defect happened (the writer stamped one
 * field, the reader keyed on another, and the step looked answered forever).
 *
 * Both stay inside the route's key rules — 53 and 47 characters against a cap
 * of 64, and every character is in its allowed set.
 */
export const REGULATOR_FILING_PREFIX = "packD:filed:";
export const REGULATOR_SKIP_PREFIX = "packD:skip:";

export function regulatorFilingStepId(disputeId: string, doorId: string): string {
  return `${REGULATOR_FILING_PREFIX}${disputeId}:${doorId}`;
}
export function regulatorSkipStepId(disputeId: string): string {
  return `${REGULATOR_SKIP_PREFIX}${disputeId}`;
}

/**
 * The case's regulator complaints, read from the claim's guided steps.
 *
 * Prefix-scanned rather than matched against the door registry, for the same
 * reason the collections steps are (`packC:`): the projector stays free of the
 * guides registry, and a door added there needs no change here.
 *
 * Keys for letters that no longer exist (a withdrawn dispute) are simply never
 * matched by any rendered letter — cancelled rows are filtered out of the
 * projection upstream, so an orphan key is inert rather than wrong.
 */
function projectRegulatorComplaint(
  claimGuideSteps: Record<
    string,
    { checkedAt?: string | null; skippedAt?: string | null; note?: string }
  >,
): ProjectedRegulatorComplaint {
  const filings: ProjectedRegulatorFiling[] = [];
  const declinedByDispute: Record<string, string> = {};

  for (const [stepId, row] of Object.entries(claimGuideSteps)) {
    if (stepId.startsWith(REGULATOR_FILING_PREFIX)) {
      // `packD:filed:<disputeId>:<doorId>` — exactly four segments. A
      // three-segment key is the pre-S303 claim-wide shape and is ignored
      // rather than guessed at.
      const parts = stepId.split(":");
      if (parts.length !== 4) continue;
      const [, , disputeId, doorId] = parts;
      if (!disputeId || !doorId) continue;
      // A filing is the ATTESTATION, never the note: a confirmation number
      // typed and not confirmed is not a filing (S301 — a step whose done-ness
      // comes from a field nothing stamps looks answered forever).
      if (typeof row?.checkedAt !== "string" || row.checkedAt.length === 0) continue;
      filings.push({
        doorId,
        disputeId,
        filedAt: row.checkedAt,
        note: typeof row.note === "string" && row.note.length > 0 ? row.note : null,
      });
      continue;
    }
    if (stepId.startsWith(REGULATOR_SKIP_PREFIX)) {
      const disputeId = stepId.slice(REGULATOR_SKIP_PREFIX.length);
      if (disputeId.length === 0) continue;
      if (typeof row?.skippedAt !== "string" || row.skippedAt.length === 0) continue;
      declinedByDispute[disputeId] = row.skippedAt;
    }
  }

  filings.sort(
    (a, b) =>
      normalizeTs(a.filedAt) - normalizeTs(b.filedAt) ||
      a.doorId.localeCompare(b.doorId),
  );
  return { filings, declinedByDispute };
}

/** NUMERIC → number. Null/absent/NaN → null (never a silent 0). */
function coerceAmount(v: number | string | null | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
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
  // Claim-scoped guided-step state rides in so the collections steps arrive ON
  // the projection (see ProjectedLetterStep.collectionsSteps).
  const claimGuideSteps =
    ((input.claim.metadata ?? {}).guideSteps as
      | Record<string, { checkedAt?: string | null; skippedAt?: string | null; note?: string }>
      | undefined) ?? {};
  // The open-rung test needs every letter on the case. Both facts it reads —
  // render letter type and coarse status — are on the raw rows, so this is
  // computed ONCE before the map rather than as a second pass that would have
  // to recompute stages it had already produced.
  const caseLetters: CaseLetterRef[] = claimDisputes.map((d) => ({
    disputeId: d.id,
    letterType: resolveLetterType(d),
    status: d.status,
  }));
  const letters = claimDisputes
    .map((d) => projectLetterStep(d, claimGuideSteps, caseLetters))
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
    regulator: projectRegulatorComplaint(claimGuideSteps),
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
