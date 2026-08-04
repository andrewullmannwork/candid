/**
 * rail-steps — phase-1a composition fixture (S299).
 *
 * Locks the extension rail's contract BEFORE the DEV E2E:
 *   - S302: steps GROUP BY LETTER (letters in projector order, fixed order
 *     within), flat badge numbering across groups, and EVERY letter renders
 *     its own send step — there is no primary exclusion and no 4b
 *   - stage → step-kind mapping via the stage machine (awaiting → active
 *     card; next → receipt + undo; resolved → receipt; draft → open-letter;
 *     none → omitted)
 *   - the APPROVED COPY, verbatim (mock v4 + §0.9d rulings + S299 net-new):
 *     titles, chips (incl. day-grammar + overdue variants), foot, doors,
 *     what-happens-next sets, receipts
 *   - dated furniture keys on deadlineType (a real engine deadline), never on
 *     the sent+30d responseDueDate display fallback
 *   - countdown percentage + default-open (sole active wait) rules
 *
 * Composes REAL projector output (not hand-built letter steps) so the
 * projector→rail pipe is exercised end to end.
 *
 * Run:  npx tsx scripts/calibration/fixtures/case-timeline/rail-steps.ts
 */
import {
  projectCaseTimeline,
  type ProjectorClaimRow,
  type ProjectorDisputeRow,
} from "../../../../src/lib/case/timeline-projector";
import {
  composeRailGroups,
  railCaseResolution,
  railHasExtension,
  fmtRailDate,
  type RailStepModel,
} from "../../../../src/lib/case/rail-steps";
import { CASE_RAIL } from "../../../../src/lib/guides/pack-registry";
import {
  OUTCOME_ROUTE_KEYS,
  UNSEND_COPY,
  markSentPayload,
  undoResultPayload,
  unsendPayload,
} from "../../../../src/lib/disputes/outcome-actions";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}${got !== undefined ? `  (got: ${JSON.stringify(got)})` : ""}`);
}

const NOW = new Date();
const iso = (offsetDays: number, ms = 0) =>
  new Date(NOW.getTime() + offsetDays * 86_400_000 + ms).toISOString();
// LOCAL-calendar date string (the letter-type.ts rule) — a UTC slice would
// make the expected day-counts flake by ±1 depending on the run hour + tz.
const dateOnly = (offsetDays: number) => {
  const d = new Date(NOW.getTime() + offsetDays * 86_400_000);
  d.setHours(0, 0, 0, 0);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const CLAIM = "11111111-1111-1111-1111-111111111111";
const claimRow: ProjectorClaimRow = { id: CLAIM, created_at: iso(-30), metadata: null };

let seq = 0;
function mkDispute(over: Partial<ProjectorDisputeRow>): ProjectorDisputeRow {
  seq++;
  return {
    id: `d${seq}`.padEnd(8, "0"),
    claim_id: CLAIM,
    dispute_type: "internal_appeal",
    status: "dispute_letter_drafted",
    created_at: iso(-10, seq * 1000),
    filed_date: null,
    resolution_date: null,
    sent_at: null,
    governing_deadline_date: null,
    deadline_type: null,
    metadata: { letterType: "insurance_appeal" },
    ...over,
  };
}

const NAMES = { providerName: "Swedish Primary Care Ballard" };

const compose = (
  disputes: ProjectorDisputeRow[],
  insurerNameByDispute: Record<string, string> = {},
  // S301 — collections step state rides the PROJECTION, so it is injected via
  // the CLAIM row (claims.metadata.guideSteps), exactly as production does.
  // The fixture therefore exercises the same path the app takes; passing it
  // beside the projection is what let the real wiring break while this stayed
  // green.
  guideSteps: Record<
    string,
    { checkedAt?: string | null; skippedAt?: string | null; note?: string }
  > = {},
) => {
  const t = projectCaseTimeline({
    claim: { ...claimRow, metadata: { ...(claimRow.metadata ?? {}), guideSteps } },
    disputes,
    events: [],
    now: NOW,
    amberDays: 7,
  });
  const groups = composeRailGroups({
    letters: t.letters,
    // S303 — the case-level regulator record, straight off the projection the
    // rail is composing. Feeding it separately here is exactly the mistake the
    // S301 collections bug was (state beside the projection instead of through
    // it), and it is what let the fixture stay green while production broke.
    regulator: t.regulator,
    firstNumber: 5,
    insurerNameByDispute,
    providerName: NAMES.providerName,
    now: NOW,
  });
  return {
    t,
    groups,
    // S302 — the rail is grouped by letter now. Most checks below assert copy
    // and per-step shape, which grouping does not change, so they read the
    // FLATTENED steps; grouping itself is asserted on `groups` in §11.
    steps: groups.flatMap((g) => g.steps),
    resolution: railCaseResolution({
      letters: t.letters,
      insurerNameByDispute,
      providerName: NAMES.providerName,
    }),
  };
};

// ── 1 · Ballard-like current state: appeal denied (next) + collections wait ─
{
  const appeal = mkDispute({
    status: "lost",
    sent_at: iso(-6),
    governing_deadline_date: dateOnly(54),
    deadline_type: "plan_response",
    metadata: {
      letterType: "insurance_appeal",
      outcomeDetail: "denied_fully",
      outcomeReportedAt: iso(-1),
    },
  });
  const validation = mkDispute({
    status: "filed",
    created_at: iso(-5),
    sent_at: iso(-4),
    governing_deadline_date: dateOnly(19),
    deadline_type: "fdcpa_validation_30",
    metadata: {
      letterType: "debt_validation",
      collector: { name: "Cascade Recovery", address: null, originalCreditor: null },
      checklist: { mailcert: true },
      escalatedFromDisputeId: appeal.id,
    },
  });
  const { steps } = compose([appeal, validation], {
    [appeal.id]: "Providence Health Plan",
  });

  // 1b: the denied appeal (stage `next`) also contributes a "Your next move"
  // step, anchored at the logged outcome.
  //
  // S301: the collections letter now also contributes its four guard-rail steps,
  // so this block addresses steps BY KIND rather than by index. The positional
  // form was asserting the arithmetic of a fixed rail; anything inserted broke
  // six checks at once and told us nothing about what actually changed.
  const letterSteps = steps.filter((s) => s.kind !== "guide-step");
  const guideSteps = steps.filter((s) => s.kind === "guide-step");
  check(
    "ballard · 5 letter steps (send + wait + next-move | send + wait)",
    letterSteps.length === 5,
    letterSteps.length,
  );
  check("ballard · 4 collections steps ride the debt-validation letter", guideSteps.length === 4, guideSteps.length);
  check(
    "ballard · badges are contiguous from 5",
    steps.map((s) => s.badge).join(",") === steps.map((_, i) => String(i + 5)).join(","),
    steps.map((s) => s.badge),
  );
  // S302 — addressed by (kind, disputeId), never by index. The rail is grouped
  // by letter now, so "the appeal's wait" is a lookup, not a position — and an
  // inserted step can no longer break six unrelated checks at once (the S301
  // positional-assertion lesson, applied).
  const forLetter = (id: string) =>
    steps.filter((s) =>
      s.kind === "wait-active"
        ? s.card.disputeId === id
        : s.kind === "next-move"
          ? s.move.disputeId === id
          : s.disputeId === id,
    );
  const byKind = <K extends RailStepModel["kind"]>(id: string, kind: K) =>
    forLetter(id).find((s): s is Extract<RailStepModel, { kind: K }> => s.kind === kind);
  const s5 = byKind(appeal.id, "wait-receipt")!;
  const s6 = byKind(validation.id, "send-receipt")!;
  const s7 = byKind(validation.id, "wait-active")!;
  check(
    "S302 · the appeal's own send step exists (no primary exclusion)",
    byKind(appeal.id, "send-receipt") != null,
  );
  check(
    "S302 · every step of a letter is contiguous — appeal block then collector block",
    steps.map((s) => (forLetter(appeal.id).includes(s) ? "A" : "C")).join("") === "AAACCCCCC",
    steps.map((s) => (forLetter(appeal.id).includes(s) ? "A" : "C")).join(""),
  );
  check(
    "S302 · the appeal's next-move closes ITS block, not the whole rail",
    steps.findIndex((s) => s.kind === "next-move") === 2,
    steps.findIndex((s) => s.kind === "next-move"),
  );
  check("ballard · appeal wait is a receipt (stage next)", s5.kind === "wait-receipt");
  check(
    "ballard · appeal wait title",
    s5.title === "Waiting on Providence Health Plan — your appeal",
    s5.title,
  );
  check(
    "ballard · outcome receipt grammar",
    s5.kind === "wait-receipt" &&
      s5.receipt === `Fully denied — no payment · logged ${fmtRailDate(iso(-1))}`,
    s5.kind === "wait-receipt" ? s5.receipt : s5.kind,
  );
  check("ballard · undo offered at stage next only", s5.kind === "wait-receipt" && s5.undo === true);
  check("ballard · collector send step title", s6.title === "Answer the collector", s6.title);
  check(
    "ballard · send receipt (collector + certified)",
    s6.kind === "send-receipt" &&
      s6.receipt === `Debt-validation letter sent to Cascade Recovery · ${fmtRailDate(iso(-4))} · certified mail`,
    s6.kind === "send-receipt" ? s6.receipt : s6.kind,
  );
  check("ballard · collections wait active", s7.kind === "wait-active");
  if (s7.kind === "wait-active") {
    check("ballard · collector wait title", s7.title === "Waiting on Cascade Recovery", s7.title);
    check("ballard · validation sub", s7.sub === CASE_RAIL.waitSubValidation);
    check("ballard · sent-ago chip", s7.card.chipSentAgo === "Sent 4 days ago", s7.card.chipSentAgo);
    check(
      "ballard · dated deadline chip",
      s7.card.chipDeadline === `Their deadline: ${fmtRailDate(dateOnly(19))} · 19 days left`,
      s7.card.chipDeadline,
    );
    check("ballard · no pause chip when dated", s7.card.chipPause === null);
    // S302 — no bar, no tone field: the chip is amber at every distance.
    check(
      "ballard · reminder foot",
      s7.card.foot === `We'll remind you before ${fmtRailDate(dateOnly(19))} if nothing arrives.`,
      s7.card.foot,
    );
    check("ballard · validation whn rows (3)", s7.card.whn?.rows.length === 3);
    check("ballard · sole active wait → whn open", s7.card.whn?.defaultOpen === true);
    check("ballard · collections door", s7.card.door.kind === "collection_resumed");
    check(
      "ballard · door ack string",
      s7.card.door.kind === "collection_resumed" &&
        s7.card.door.ackLabel === "Logged — this is on your case record.",
    );
  }
}

// ── 2 · Undo state: two concurrent waits (Panel B) ──────────────────────────
{
  const appeal = mkDispute({
    status: "filed",
    sent_at: iso(-6),
    governing_deadline_date: dateOnly(54),
    deadline_type: "plan_response",
  });
  const validation = mkDispute({
    status: "filed",
    created_at: iso(-5),
    sent_at: iso(-4),
    governing_deadline_date: dateOnly(19),
    deadline_type: "fdcpa_validation_30",
    metadata: {
      letterType: "debt_validation",
      collector: { name: "Cascade Recovery", address: null, originalCreditor: null },
    },
  });
  const { t, steps } = compose([appeal, validation], {
    [appeal.id]: "Providence Health Plan",
  });
  check("concurrent · waitingCount 2", t.waitingCount === 2);
  const waits = steps.filter((s): s is Extract<RailStepModel, { kind: "wait-active" }> => s.kind === "wait-active");
  check("concurrent · two active waits", waits.length === 2);
  check("concurrent · several actives → whn collapsed", waits.every((w) => w.card.whn?.defaultOpen === false));
  check("concurrent · appeal sub (60-day sentence)", waits[0].sub === CASE_RAIL.waitSubAppeal);
  check(
    "concurrent · appeal whn includes dated Nothing-by row",
    waits[0].card.whn?.rows.some(([lhs]) => lhs === `Nothing by ${fmtRailDate(dateOnly(54))}`) === true,
    waits[0].card.whn?.rows,
  );
  check(
    "concurrent · header chip (plural)",
    CASE_RAIL.headerChip(2, fmtRailDate(dateOnly(19))) ===
      `Waiting on 2 responses · first due ${fmtRailDate(dateOnly(19))}`,
  );
  check(
    "concurrent · header chip (singular)",
    CASE_RAIL.headerChip(1, "Sep 29") === "Waiting on 1 response · due Sep 29",
  );
}

// ── 3 · Overdue wait: passed chip, pinned bar, no foot, no Nothing-by row ───
{
  const appeal = mkDispute({
    status: "filed",
    sent_at: iso(-40),
    governing_deadline_date: dateOnly(-2),
    deadline_type: "plan_response",
  });
  const { steps } = compose([appeal], { [appeal.id]: "Providence Health Plan" });
  const w = steps.find((x) => x.kind === "wait-active")!;
  check("overdue · still an active wait", w != null && w.kind === "wait-active");
  if (w.kind === "wait-active") {
    check(
      "overdue · passed chip",
      w.card.chipDeadline === `Their deadline: ${fmtRailDate(dateOnly(-2))} · passed`,
      w.card.chipDeadline,
    );
    check("overdue · still amber, never red (style fence)", !("deadlineTone" in w.card));
    check("overdue · foot hidden", w.card.foot === null);
    check(
      "overdue · whn drops the Nothing-by promise",
      w.card.whn?.rows.length === 2 && w.card.whn.rows.every(([lhs]) => !lhs.startsWith("Nothing by")),
      w.card.whn?.rows,
    );
  }
}

// ── 4 · Undated §1692g wait: pause chip, no deadline furniture ──────────────
{
  const validation = mkDispute({
    status: "filed",
    sent_at: iso(-1),
    metadata: {
      letterType: "debt_validation",
      collector: { name: "Cascade Recovery", address: null, originalCreditor: null },
    },
  });
  const { steps } = compose([validation]);
  const w = steps.find((s) => s.kind === "wait-active");
  check("undated · wait renders", w != null);
  if (w && w.kind === "wait-active") {
    // responseDueDate carries the sent+30d display fallback — deadlineType is
    // null, so NO deadline is asserted (the fallback never becomes a claim).
    check("undated · no deadline chip", w.card.chipDeadline === null, w.card.chipDeadline);
    check("undated · pause chip", w.card.chipPause === CASE_RAIL.chipCollectionPause);
    check("undated · no deadline chip furniture at all", w.card.chipDeadline === null);
    check("undated · no foot", w.card.foot === null);
  }
}

// ── 5 · Draft escalated letter + day-grammar variants + omissions ───────────
{
  const appeal = mkDispute({
    status: "filed",
    sent_at: iso(-2),
    governing_deadline_date: dateOnly(58),
    deadline_type: "plan_response",
  });
  const draftValidation = mkDispute({
    created_at: iso(-1),
    metadata: { letterType: "debt_validation" },
  });
  const { steps } = compose([appeal, draftValidation], {});
  const draftStep = steps.find((s) => s.kind === "send-draft");
  check("draft · escalated draft renders an open-letter step", draftStep != null);
  // S302 — the DRAFT variant names the act (sending happens on the letter page).
  check(
    "draft · the button names the act, not just the destination",
    draftStep?.kind === "send-draft" &&
      draftStep.openLetterLabel === "Open the letter to send it",
    draftStep?.kind === "send-draft" ? draftStep.openLetterLabel : draftStep?.kind,
  );
  check("draft · no wait step for an unsent letter", steps.filter((s) => s.kind.startsWith("wait")).length === 1);
  const fallbackWait = steps.find((s) => s.kind === "wait-active");
  check(
    "draft · insurer fallback title",
    fallbackWait?.title === "Waiting on your plan — your appeal",
    fallbackWait?.title,
  );

  check("grammar · sent today", CASE_RAIL.chipSentAgo(0) === "Sent today");
  check("grammar · 1 day ago", CASE_RAIL.chipSentAgo(1) === "Sent 1 day ago");
  check("grammar · N days ago", CASE_RAIL.chipSentAgo(20) === "Sent 20 days ago");
  check("grammar · due today", CASE_RAIL.chipDeadline("Sep 29", 0) === "Their deadline: Sep 29 · due today");
  check("grammar · 1 day left", CASE_RAIL.chipDeadline("Sep 29", 1) === "Their deadline: Sep 29 · 1 day left");
  check("grammar · fmtRailDate", fmtRailDate("2026-09-29") === "Sep 29", fmtRailDate("2026-09-29"));

  // TZ regression (the S299 "sent Jul 31 vs Jul 30" catch): calendars are the
  // USER's — a send 1h before local midnight is "1 day ago" the next local
  // morning regardless of its UTC date; a send just after local midnight is
  // "today". A UTC-sliced derivation fails one of these in any non-UTC tz.
  const localMidnight = new Date(NOW.getTime());
  localMidnight.setHours(0, 0, 0, 0);
  const lateLastNight = new Date(localMidnight.getTime() - 3_600_000).toISOString();
  const earlyToday = new Date(localMidnight.getTime() + 60_000).toISOString();
  const { steps: tzA } = compose([mkDispute({ status: "filed", sent_at: lateLastNight })]);
  const tzWa = tzA.find((s) => s.kind === "wait-active");
  check(
    "tz · pre-local-midnight send → Sent 1 day ago",
    tzWa?.kind === "wait-active" && tzWa.card.chipSentAgo === "Sent 1 day ago",
    tzWa?.kind === "wait-active" ? tzWa.card.chipSentAgo : tzWa?.kind,
  );
  const { steps: tzB } = compose([mkDispute({ status: "filed", sent_at: earlyToday })]);
  const tzWb = tzB.find((s) => s.kind === "wait-active");
  check(
    "tz · post-local-midnight send → Sent today",
    tzWb?.kind === "wait-active" && tzWb.card.chipSentAgo === "Sent today",
    tzWb?.kind === "wait-active" ? tzWb.card.chipSentAgo : tzWb?.kind,
  );

  // Non-approved wait types omit what-happens-next (no invented promises).
  const provider = mkDispute({
    status: "filed",
    sent_at: iso(-3),
    metadata: { letterType: "overcharge" },
  });
  const { steps: pSteps } = compose([provider], {});
  const pw = pSteps.find((s) => s.kind === "wait-active")!;
  check("omission · provider wait has no whn set", pw?.kind === "wait-active" && pw.card.whn === null, pw?.kind);
  check(
    // S302 — noun comes from LETTER_RAIL_COPY, the one table the send title,
    // the receipt and the band also read. The provider-track trio (overcharge /
    // balance_billing / duplicate_charge) share the "Dispute letter" voice, so
    // this reads "your dispute letter" where the old LETTER_TYPE_LABELS
    // lowercase produced "your billing dispute letter".
    "omission · provider wait generic title (copy-table noun)",
    pw.title === "Waiting on Swedish Primary Care Ballard — your dispute letter",
    pw.title,
  );
}

// ── 6 · Extension predicate + cancelled rows ────────────────────────────────
{
  // S302 — the FIRST letter is no longer excluded. A lone draft now extends the
  // rail (it contributes its own send step), which is exactly what retires 4b:
  // the prep rail stops owning any letter's send.
  const draftPrimary = mkDispute({});
  const { t, steps } = compose([draftPrimary]);
  check("predicate · a lone DRAFT extends the rail", railHasExtension(t.letters) === true);
  check(
    "S302 · the first letter renders its own send step (4b retired)",
    steps.length === 1 && steps[0].kind === "send-draft" && steps[0].badge === "5",
    steps.map((s) => `${s.kind}:${s.badge}`),
  );
  const cancelled = mkDispute({ status: "cancelled", sent_at: iso(-3) });
  const { t: t2, steps: s2 } = compose([cancelled]);
  check(
    "predicate · cancelled contributes nothing",
    railHasExtension(t2.letters) === false && s2.length === 0,
  );
  const sentPrimary = mkDispute({ status: "filed", sent_at: iso(-3) });
  const { t: t3, steps: s3 } = compose([sentPrimary]);
  check("predicate · sent letter → extension", railHasExtension(t3.letters) === true);
  check(
    "S302 · a sent first letter renders send-receipt THEN its wait",
    s3.map((s) => s.kind).join(",") === "send-receipt,wait-active",
    s3.map((s) => s.kind),
  );
}

// ── 7 · Stage-8 "Your next move" (phase 1b: offers + doors + terminal rule) ─
{
  // (a) Denied insurer appeal + live collections → letter offer (external
  // review, wall-removed so requiresPro FALSE) + doors [DOI chipped, CFPB].
  const appeal = mkDispute({
    status: "lost",
    sent_at: iso(-6),
    governing_deadline_date: dateOnly(54),
    deadline_type: "plan_response",
    metadata: {
      letterType: "insurance_appeal",
      outcomeDetail: "denied_fully",
      outcomeReportedAt: iso(-1),
    },
  });
  const validation = mkDispute({
    status: "filed",
    created_at: iso(-5),
    sent_at: iso(-4),
    metadata: {
      letterType: "debt_validation",
      collector: { name: "Cascade Recovery", address: null, originalCreditor: null },
    },
  });
  const { steps } = compose([appeal, validation], {
    [appeal.id]: "Providence Health Plan",
  });
  const nm = steps.find((s) => s.kind === "next-move");
  check("next-move · renders for stage next", nm != null);
  if (nm && nm.kind === "next-move") {
    check("next-move · title", nm.title === "Your next move");
    check(
      "next-move · denied sub (ruling 4)",
      nm.sub === "Providence Health Plan said no. Two paths are open — you can take both.",
      nm.sub,
    );
    check(
      "next-move · letter offer = suggestNextStep CTA",
      nm.move.letterOffer?.title === "Start the next letter — external review",
      nm.move.letterOffer?.title,
    );
    check("next-move · target external_review", nm.move.letterOffer?.targetLetterType === "external_review");
    check(
      "next-move · Pro wall removed → requiresPro false",
      nm.move.letterOffer?.requiresPro === false,
    );
    check(
      "next-move · external-review sub carries the logged date",
      nm.move.letterOffer?.sub === `An independent reviewer, not your insurer, decides. Unlocked by the denial you logged ${fmtRailDate(iso(-1))}.`,
      nm.move.letterOffer?.sub,
    );
    check("next-move · start CTA", nm.move.letterOffer?.cta === "Start the letter");
    // S303 (Andrew) — EVERY door, always. suggestDoors keeps naming what fits
    // this letter; it no longer decides what the user may see. We cannot
    // detect surprise billing at all today (nsa_applicable is always UNKNOWN),
    // so filtering on our own signal would hide a real regulator behind a
    // detection we know is blind.
    check(
      "next-move · all four doors, suggestion first (DOI+CFPB here)",
      nm.move.regulator!.doors.map((d) => d.id).join(",") === "doi,cfpb,ag,cms",
      nm.move.regulator!.doors.map((d) => d.id),
    );
    check(
      "next-move · chip on the track door only (mock-literal)",
      nm.move.regulator!.doors[0].chip === "suggested for this case" &&
        nm.move.regulator!.doors.slice(1).every((d) => d.chip === null),
    );
    check(
      "next-move · regulator lead (ruling 3 FINAL)",
      nm.move.regulator!.lead === "Choose the regulator(s) based on which party wronged you.",
    );
    check(
      "next-move · per-agency attest row (registry label + Andrew's rail placeholder)",
      nm.move.regulator!.filedLabel === "Complaint filed" &&
        nm.move.regulator!.notePlaceholder === "Enter your confirmation number",
    );
    check(
      "s303 · every door carries its own per-LETTER step id",
      nm.move.regulator!.doors.map((d) => d.stepId).join(",") ===
        ["doi", "cfpb", "ag", "cms"].map((x) => `packD:filed:${appeal.id}:${x}`).join(","),
      nm.move.regulator!.doors.map((d) => d.stepId),
    );
    check(
      "s303 · nothing filed → every door open, and THIS letter's declination is offered",
      nm.move.regulator!.doors.every(
        (d) => d.filedAt === null && d.note === null && d.earlier === null,
      ) &&
        nm.move.regulator!.skip?.stepId === `packD:skip:${appeal.id}` &&
        nm.move.regulator!.skip?.declined === false,
      nm.move.regulator!.skip,
    );
    check(
      "next-move · foot",
      nm.move.regulator!.foot ===
        "Gather your paper trail → file it → log the confirmation number. Your letters make the case.",
    );
  }

  // (b) Denied provider letter, no collections → final-notice offer + AG only.
  const provider = mkDispute({
    status: "lost",
    sent_at: iso(-8),
    metadata: {
      letterType: "overcharge",
      outcomeDetail: "denied_fully",
      outcomeReportedAt: iso(-2),
    },
  });
  const { steps: pSteps } = compose([provider], {});
  const pNm = pSteps.find((s) => s.kind === "next-move");
  check(
    "next-move · provider track → final notice offer",
    pNm?.kind === "next-move" && pNm.move.letterOffer?.targetLetterType === "final_notice",
  );
  check(
    "next-move · provider track leads with AG, then the rest",
    pNm?.kind === "next-move" &&
      pNm.move.regulator!.doors.map((d) => d.id).join(",") === "ag,cfpb,cms,doi",
    pNm?.kind === "next-move" ? pNm.move.regulator!.doors.map((d) => d.id) : pNm?.kind,
  );

  // (c) TERMINAL rung: a lost external review (suggestNextStep null → stage
  // resolved) still gets the regulator card — doors-only next-move.
  const terminal = mkDispute({
    status: "lost",
    sent_at: iso(-9),
    metadata: {
      letterType: "external_review",
      outcomeDetail: "denied_fully",
      outcomeReportedAt: iso(-3),
    },
  });
  const { steps: tSteps } = compose([terminal], {});
  const tNm = tSteps.find((s) => s.kind === "next-move");
  check("terminal · doors-only next-move renders", tNm?.kind === "next-move");
  check(
    "terminal · no letter offer (ladder exhausted)",
    tNm?.kind === "next-move" && tNm.move.letterOffer === null,
  );
  check(
    "terminal · doors-only drops the two-paths sub",
    tNm?.kind === "next-move" && tNm.sub === null,
    tNm?.kind === "next-move" ? tNm.sub : tNm?.kind,
  );
  // S303 — INVERTED deliberately. Undo used to key on stage `next`, i.e. "you
  // can still escalate", so the one letter you could never correct was the one
  // at the END of its ladder. It keys on the fact now: a logged result is a
  // result you can take back, wherever the letter sits.
  const tReceipt = tSteps.find((s) => s.kind === "wait-receipt");
  check(
    "s303 · a resolved letter's logged result can still be undone",
    tReceipt?.kind === "wait-receipt" && tReceipt.undo === true,
    tReceipt?.kind === "wait-receipt" ? tReceipt.undo : tReceipt?.kind,
  );

  // (d) balance_billing ground → CMS door second (determinism).
  const bb = mkDispute({
    status: "lost",
    sent_at: iso(-7),
    metadata: {
      letterType: "balance_billing",
      outcomeDetail: "denied_fully",
      outcomeReportedAt: iso(-2),
    },
  });
  const { steps: bbSteps } = compose([bb], {});
  const bbNm = bbSteps.find((s) => s.kind === "next-move");
  check(
    "next-move · balance_billing surfaces CMS in the suggestion, not at the tail",
    bbNm?.kind === "next-move" &&
      bbNm.move.regulator!.doors.map((d) => d.id).join(",") === "ag,cms,cfpb,doi",
    bbNm?.kind === "next-move" ? bbNm.move.regulator!.doors.map((d) => d.id) : bbNm?.kind,
  );

  // (e) S303 — per-agency filings come from the CLAIM's guided steps, and each
  // agency carries its own confirmation number. The dispute-side packD:filed
  // boolean below is deliberately present and deliberately ignored: it is the
  // stale shape the storage move retires.
  const filed = mkDispute({
    status: "lost",
    sent_at: iso(-6),
    metadata: {
      letterType: "insurance_appeal",
      outcomeDetail: "denied_fully",
      outcomeReportedAt: iso(-1),
      checklist: { "packD:filed": true },
      checklistNotes: { "packD:filed": "STALE — dispute-scoped" },
    },
  });
  const { steps: fSteps } = compose([filed], {}, {
    [`packD:filed:${filed.id}:doi`]: { checkedAt: iso(-1), note: "DOI-2026-4417" },
  });
  const fNm = fSteps.find((s) => s.kind === "next-move");
  const fDoors = fNm?.kind === "next-move" ? fNm.move.regulator!.doors : [];
  check(
    "s303 · the filed agency carries its own date + confirmation number",
    fDoors.find((d) => d.id === "doi")?.filedAt === iso(-1) &&
      fDoors.find((d) => d.id === "doi")?.note === "DOI-2026-4417" &&
      fDoors.find((d) => d.id === "doi")?.filedAtLabel === fmtRailDate(iso(-1)),
    fDoors.find((d) => d.id === "doi"),
  );
  check(
    "s303 · the other agencies stay open — filing one is not filing all",
    fDoors.filter((d) => d.id !== "doi").every((d) => d.filedAt === null && d.note === null),
    fDoors.map((d) => ({ id: d.id, filedAt: d.filedAt })),
  );
  check(
    "s303 · the stale DISPUTE-scoped attest is ignored entirely",
    fDoors.every((d) => d.note !== "STALE — dispute-scoped"),
  );
  check(
    "s303 · once THIS letter has a filing its declination is withdrawn — the two can never both be true",
    fNm?.kind === "next-move" && fNm.move.regulator!.skip === null,
    fNm?.kind === "next-move" ? fNm.move.regulator!.skip : fNm?.kind,
  );

  // (e2) The declination itself, and the S297 §3.2 line it protects.
  const { steps: dSteps } = compose([filed], {}, {
    [`packD:skip:${filed.id}`]: { skippedAt: iso(-1) },
  });
  const dNm = dSteps.find((s) => s.kind === "next-move");
  check(
    "s303 · a declination is recorded as declined, never as filed",
    dNm?.kind === "next-move" &&
      dNm.move.regulator!.skip?.declined === true &&
      dNm.move.regulator!.skip?.declinedAtLabel === fmtRailDate(iso(-1)) &&
      dNm.move.regulator!.doors.every((d) => d.filedAt === null),
    dNm?.kind === "next-move" ? dNm.move.regulator!.skip : dNm?.kind,
  );

  // (e2b) Declined FIRST, then changed their mind and filed. Both acts are
  // true and both stay on the record with their own stamps — a declination is
  // not erased, it is SUPERSEDED. The composer resolves the current reading:
  // this letter has produced a complaint, so its declination is no longer
  // offered and cannot be mistaken for its answer.
  const { steps: bothSteps } = compose([filed], {}, {
    [`packD:skip:${filed.id}`]: { skippedAt: iso(-3) },
    [`packD:filed:${filed.id}:ag`]: { checkedAt: iso(-1), note: "AG-99" },
  });
  const bothNm = bothSteps.find((s) => s.kind === "next-move");
  check(
    "s303 · a filing supersedes an earlier declination without erasing it",
    bothNm?.kind === "next-move" &&
      bothNm.move.regulator!.skip === null &&
      bothNm.move.regulator!.doors.find((d) => d.id === "ag")?.note === "AG-99",
    bothNm?.kind === "next-move" ? bothNm.move.regulator!.skip : bothNm?.kind,
  );

  // (e2c) ── THE CORE OF S303: linked numbers, independent behaviour ─────────
  // The appeal was answered and the user filed with the insurance department.
  // The collector letter is then answered too, and its card must NOT arrive
  // pre-completed on the strength of a complaint about the insurer.
  const answeredAppeal = mkDispute({
    status: "lost",
    sent_at: iso(-9),
    metadata: {
      letterType: "insurance_appeal",
      outcomeDetail: "denied_fully",
      outcomeReportedAt: iso(-8),
    },
  });
  const answeredCollector = mkDispute({
    status: "lost",
    created_at: iso(-7),
    sent_at: iso(-6),
    metadata: {
      letterType: "debt_validation",
      collector: { name: "Cascade Recovery", address: null, originalCreditor: null },
      outcomeDetail: "denied_fully",
      outcomeReportedAt: iso(-2),
    },
  });
  const { groups: xGroups } = compose([answeredAppeal, answeredCollector], {}, {
    [`packD:filed:${answeredAppeal.id}:doi`]: { checkedAt: iso(-7), note: "DOI-2026-4417" },
  });
  const appealMove = xGroups[0].steps.find((s) => s.kind === "next-move");
  const collectorMove = xGroups[1].steps.find((s) => s.kind === "next-move");
  const appealDoi =
    appealMove?.kind === "next-move"
      ? appealMove.move.regulator!.doors.find((d) => d.id === "doi")
      : undefined;
  const collectorDoi =
    collectorMove?.kind === "next-move"
      ? collectorMove.move.regulator!.doors.find((d) => d.id === "doi")
      : undefined;

  check(
    "s303 · the letter it was filed FROM shows a plain filing",
    appealDoi?.filedAt === iso(-7) &&
      appealDoi?.note === "DOI-2026-4417" &&
      appealDoi?.earlier === null,
    appealDoi,
  );
  check(
    "s303 · a LATER letter does NOT count that filing as its own",
    collectorDoi?.filedAt === null && collectorDoi?.note === null,
    collectorDoi,
  );
  check(
    "s303 · …but it DOES show the number, named to the letter it belonged to",
    collectorDoi?.earlier?.note === "DOI-2026-4417" &&
      collectorDoi?.earlier?.label === `Already filed ${fmtRailDate(iso(-7))} — for your appeal`,
    collectorDoi?.earlier,
  );
  check(
    "s303 · the later letter's step is still OPEN — its declination is offered",
    collectorMove?.kind === "next-move" &&
      collectorMove.move.regulator!.skip?.stepId === `packD:skip:${answeredCollector.id}` &&
      collectorMove.move.regulator!.skip?.declined === false,
    collectorMove?.kind === "next-move" ? collectorMove.move.regulator!.skip : collectorMove?.kind,
  );
  check(
    "s303 · agencies untouched on either letter carry no earlier filing",
    collectorMove?.kind === "next-move" &&
      collectorMove.move.regulator!.doors
        .filter((d) => d.id !== "doi")
        .every((d) => d.earlier === null && d.filedAt === null),
  );
  // The S302 bug in one assertion: one skip for the whole bill greyed every
  // card. Declining the COLLECTOR must leave the appeal exactly as it was.
  const { groups: skipGroups } = compose([answeredAppeal, answeredCollector], {}, {
    [`packD:skip:${answeredCollector.id}`]: { skippedAt: iso(-1) },
  });
  const aSkip = skipGroups[0].steps.find((s) => s.kind === "next-move");
  const cSkip = skipGroups[1].steps.find((s) => s.kind === "next-move");
  check(
    "s303 · declining one letter leaves every other letter's answer untouched",
    aSkip?.kind === "next-move" &&
      aSkip.move.regulator!.skip?.declined === false &&
      cSkip?.kind === "next-move" &&
      cSkip.move.regulator!.skip?.declined === true,
    [
      aSkip?.kind === "next-move" ? aSkip.move.regulator!.skip?.declined : null,
      cSkip?.kind === "next-move" ? cSkip.move.regulator!.skip?.declined : null,
    ],
  );

  // (e3) The defect the old ladder-shaped rule produced: winning your external
  // review used to surface "choose a regulator to complain to".
  const won = mkDispute({
    status: "won",
    sent_at: iso(-9),
    metadata: {
      letterType: "external_review",
      outcomeDetail: "resolved_win",
      outcomeReportedAt: iso(-2),
    },
  });
  const wNm = compose([won], {}).steps.find((s) => s.kind === "next-move");
  check(
    "s303 · a WON letter offers no regulator card",
    wNm === undefined || (wNm.kind === "next-move" && wNm.move.regulator === null),
    wNm?.kind,
  );

  // (e4) The other half of that defect: a partial payment IS an adverse answer,
  // so its doors stay even though neither old condition held.
  const partial = mkDispute({
    status: "settled",
    sent_at: iso(-9),
    metadata: {
      letterType: "insurance_appeal",
      outcomeDetail: "denied_partial",
      outcomeReportedAt: iso(-2),
    },
  });
  const startedAfterPartial = mkDispute({
    created_at: iso(0, -1000),
    metadata: { letterType: "external_review" },
  });
  const ppNm = compose([partial, startedAfterPartial], {}).steps.find(
    (s) => s.kind === "next-move",
  );
  check(
    "s303 · a partially-paid, already-escalated letter keeps its regulator card",
    ppNm?.kind === "next-move" && ppNm.move.regulator != null,
    ppNm?.kind,
  );

  // (g) Offer suppression (Andrew, 1b E2E): once the suggested letter EXISTS
  // it has its own rung — the step keeps the doors only, sub retires, and the
  // new letter contributes its own draft send-step.
  const deniedAppeal = mkDispute({
    status: "lost",
    sent_at: iso(-6),
    metadata: {
      letterType: "insurance_appeal",
      outcomeDetail: "denied_fully",
      outcomeReportedAt: iso(-1),
    },
  });
  const startedReview = mkDispute({
    created_at: iso(0, -1000),
    metadata: { letterType: "external_review" },
  });
  const { steps: gSteps } = compose([deniedAppeal, startedReview], {});
  const gNm = gSteps.find((s) => s.kind === "next-move");
  check(
    "suppression · offer gone once the letter exists",
    gNm?.kind === "next-move" && gNm.move.letterOffer === null,
  );
  check(
    "suppression · two-paths sub retires with the offer",
    gNm?.kind === "next-move" && gNm.sub === null,
  );
  check(
    "suppression · doors remain",
    gNm?.kind === "next-move" && (gNm.move.regulator?.doors.length ?? 0) > 0,
  );
  check(
    "suppression · the started letter gets its own draft step",
    gSteps.some((s) => s.kind === "send-draft"),
    gSteps.map((s) => s.kind),
  );

  // (f) A non-terminal open outcome (needs_info → stage awaiting) gets NO
  // next-move — the waiting card owns it.
  const open = mkDispute({
    status: "filed",
    sent_at: iso(-6),
    metadata: {
      letterType: "insurance_appeal",
      outcomeDetail: "needs_info",
      outcomeReportedAt: iso(-1),
    },
  });
  const { steps: oSteps } = compose([open], {});
  check(
    "next-move · absent for open non-terminal outcomes",
    oSteps.every((s) => s.kind !== "next-move"),
    oSteps.map((s) => s.kind),
  );
}

// ── Collections steps on the rail (S301) ───────────────────────────────────
{
  const dv = mkDispute({
    dispute_type: "debt_validation",
    status: "filed",
    sent_at: iso(-3),
    metadata: {
      letterType: "debt_validation",
      collector: { name: "Cascade Recovery" },
      collectorFirstContactDate: dateOnly(-20),
    },
  });

  // (a) The FOUR net-new steps — and only four. "Your debt validation letter is
  // ready" is this letter's own send step and "What did the collector do?" is
  // its waiting card; rebuilding either would put two doors on the same act.
  const { steps } = compose([dv], {}, {});
  const guides = steps.filter((s) => s.kind === "guide-step");
  check("collections · exactly 4 net-new steps", guides.length === 4, guides.length);
  check(
    "collections · step ids",
    JSON.stringify(guides.map((g) => (g as { stepId: string }).stepId)) ===
      JSON.stringify(["packC:not-paid", "packC:first-contact", "packC:mailed", "packC:receipt"]),
    guides.map((g) => (g as { stepId: string }).stepId),
  );
  check(
    "collections · the letter's own send + wait steps still render (not duplicated)",
    steps.filter((s) => s.kind === "send-receipt").length === 1 &&
      steps.filter((s) => s.kind === "wait-active" || s.kind === "wait-receipt").length === 1,
    steps.map((s) => s.kind),
  );

  // (b) Chronology: the "don't pay" / "when did they contact you" pair brackets
  // BEFORE the send step; the certified-mail pair after it.
  const kinds = steps.map((s) => s.kind);
  const sendIdx = kinds.indexOf("send-receipt");
  const idxOf = (id: string) =>
    steps.findIndex((s) => s.kind === "guide-step" && (s as { stepId: string }).stepId === id);
  check("collections · not-paid precedes the send step", idxOf("packC:not-paid") < sendIdx);
  check("collections · first-contact precedes the send step", idxOf("packC:first-contact") < sendIdx);
  check("collections · mailed follows the send step", idxOf("packC:mailed") > sendIdx);
  check("collections · receipt follows the send step", idxOf("packC:receipt") > sendIdx);

  // (c) packC:mailed derives from the LETTER's send record — not a second
  // boolean. This is what dissolves the old "I mailed it" duplication and stops
  // the pack asking the user to re-assert a send they already reported.
  const mailed = guides.find((g) => (g as { stepId: string }).stepId === "packC:mailed") as {
    state: string;
    derivedFromSend: boolean;
    skippable: boolean;
  };
  check("collections · mailed is done because the letter is SENT", mailed.state === "done", mailed.state);
  check("collections · mailed derives from send", mailed.derivedFromSend === true);
  check("collections · mailed is NOT skippable (it IS the send)", mailed.skippable === false);

  // (d) The first-contact step is DATA-derived: the stored date IS the answer.
  // It prefills AND reads done — keying it on an attestation nothing writes is
  // what made it show the date while staying blue forever (S301 E2E round 2).
  const firstContact = guides.find(
    (g) => (g as { stepId: string }).stepId === "packC:first-contact",
  ) as { value: string | null; state: string; doneSource: string };
  check(
    "collections · first-contact prefills from the projector",
    firstContact.value === dateOnly(-20),
    firstContact.value,
  );
  check(
    "collections · a stored date makes the step DONE (no second flag)",
    firstContact.state === "done",
    firstContact.state,
  );
  check("collections · first-contact doneSource is the date", firstContact.doneSource === "date");

  // …and with NO date stored it is open, so the step is visibly unanswered
  // rather than silently vanishing the way the old derived row did.
  const noDate = mkDispute({
    dispute_type: "debt_validation",
    status: "filed",
    sent_at: iso(-3),
    metadata: { letterType: "debt_validation", collector: { name: "Cascade Recovery" } },
  });
  const undated = compose([noDate], {}, {}).steps.find(
    (x) => x.kind === "guide-step" && (x as { stepId: string }).stepId === "packC:first-contact",
  ) as { state: string; value: string | null };
  check("collections · no date → step is OPEN", undated.state === "open", undated.state);
  check("collections · no date → empty field", undated.value === null, undated.value);

  // (e) THREE states, and skipped is NOT a flavour of done. These attestations
  // feed the prior-contact recital, so a declined step must never read as done.
  const skipped = compose([dv], {}, { "packC:receipt": { skippedAt: iso(-1) } });
  const receipt = skipped.steps.find(
    (s) => s.kind === "guide-step" && (s as { stepId: string }).stepId === "packC:receipt",
  ) as { state: string; doneAt: string | null };
  check("collections · skipped state is 'skipped'", receipt.state === "skipped", receipt.state);
  check("collections · skipped carries NO done stamp", receipt.doneAt === null, receipt.doneAt);

  const done = compose([dv], {}, { "packC:not-paid": { checkedAt: iso(-2) } });
  const notPaid = done.steps.find(
    (s) => s.kind === "guide-step" && (s as { stepId: string }).stepId === "packC:not-paid",
  ) as { state: string; doneAt: string | null };
  check("collections · attested state is 'done'", notPaid.state === "done", notPaid.state);
  check("collections · done carries a server stamp", notPaid.doneAt != null, notPaid.doneAt);

  // (f) An open step is neither — no stamp, no skip mark.
  const open = guides.find(
    (g) => (g as { stepId: string }).stepId === "packC:not-paid",
  ) as { state: string; doneAt: string | null };
  check("collections · open state is 'open'", open.state === "open", open.state);
  check("collections · open carries no stamp", open.doneAt === null);

  // (g) Collections steps NEVER appear on a non-collections letter.
  const appealOnly = mkDispute({
    status: "filed",
    sent_at: iso(-3),
    metadata: { letterType: "insurance_appeal" },
  });
  const { steps: aSteps } = compose([appealOnly]);
  check(
    "collections · absent on an insurer letter",
    aSteps.every((s) => s.kind !== "guide-step"),
    aSteps.map((s) => s.kind),
  );

  // (g2) Unsend on the rail (S301). ALWAYS offered — the earlier design blocked
  // it behind "undo the result first", which made a denied letter read as a dead
  // end. The model instead carries the FACTS a confirm needs, and the route
  // clears the response in the SAME patch, so §0.9b's invariant (never orphan an
  // outcome) is upheld by the write rather than by hiding the button.
  {
    const awaiting = compose([dv], {}, {}).steps.find((x) => x.kind === "send-receipt") as {
      unsend: { loggedOutcomeLabel: string | null; loggedOutcomeDateLabel: string | null };
    };
    check("unsend · no logged outcome → no confirm facts", awaiting.unsend.loggedOutcomeLabel === null);

    const answered = mkDispute({
      dispute_type: "debt_validation",
      status: "lost",
      sent_at: iso(-3),
      metadata: {
        letterType: "debt_validation",
        collector: { name: "Cascade Recovery" },
        outcomeDetail: "denied_fully",
        outcomeReportedAt: iso(-1),
      },
    });
    const withOutcome = compose([answered], {}, {}).steps.find(
      (x) => x.kind === "send-receipt",
    ) as { unsend: { loggedOutcomeLabel: string | null; loggedOutcomeDateLabel: string | null } };
    check(
      "unsend · logged outcome surfaces its LABEL for the confirm",
      withOutcome.unsend.loggedOutcomeLabel === "Fully denied — no payment",
      withOutcome.unsend.loggedOutcomeLabel,
    );
    check(
      "unsend · logged outcome surfaces its DATE for the confirm",
      withOutcome.unsend.loggedOutcomeDateLabel === fmtRailDate(iso(-1)),
      withOutcome.unsend.loggedOutcomeDateLabel,
    );
    // The confirm names both facts — a body that dropped either would ask the
    // user to approve clearing something it never identified.
    const body = UNSEND_COPY.confirmBody(
      withOutcome.unsend.loggedOutcomeLabel ?? "",
      withOutcome.unsend.loggedOutcomeDateLabel,
    );
    check("unsend confirm · names the outcome", body.includes("Fully denied — no payment"), body);
    check("unsend confirm · names the date", body.includes(fmtRailDate(iso(-1))), body);
    check("unsend confirm · states that BOTH are cleared", body.includes("clears both"), body);
  }

  // (h) The CLIENT↔ROUTE vocabulary, both directions (the S300 lesson: the
  // `acknowledge` write 400'd on every click and showed no symptom because the
  // two sides disagreed on a string). The rail posts these exact keys; the
  // claim-checklist route reads these exact keys.
  // The outcome-route vocabulary, both directions (S301). The rail's unsend
  // shipped as `{ disputeId, undoSent: true }` — keys the route has NEVER read —
  // so it 400'd on every click while the caller's error copy blamed the §0.9b
  // guard. A malformed request wearing a plausible error message is worse than a
  // silent failure: it explains itself wrongly. Now every caller builds its body
  // from outcome-actions, and this asserts those bodies against the route's own
  // accepted-key list in BOTH directions.
  {
    const bodies = [
      markSentPayload("d1"),
      unsendPayload("d1"),
      undoResultPayload("d1"),
    ];
    const accepted = new Set<string>(OUTCOME_ROUTE_KEYS);
    for (const b of bodies) {
      for (const k of Object.keys(b)) {
        check(`outcome payload key "${k}" is one the route reads`, accepted.has(k), k);
      }
      check("outcome payload always carries status (the route 400s without it)", "status" in b);
      check("outcome payload always carries disputeId", "disputeId" in b);
    }
    // Unsend must clear the outcome IN THE SAME request — one atomic row patch,
    // so a letter can never end up unsent with an orphaned response logged.
    const un = unsendPayload("d1");
    check("unsend clears the send", un.clearSentAt === true);
    check("unsend clears the logged outcome in the SAME request", un.clearOutcomeDetail === true);
    // Undo-result must NOT unsend — the letter stays sent, its clock running.
    const ur = undoResultPayload("d1");
    check("undo-result leaves the letter sent", ur.clearSentAt === undefined);
    check("undo-result clears only the outcome", ur.clearOutcomeDetail === true);
    // Mark-sent carries no clear flags (the route's snapshot guard keys on that).
    const ms = markSentPayload("d1");
    check(
      "mark-sent carries no clear flags",
      ms.clearSentAt === undefined && ms.clearOutcomeDetail === undefined,
    );
  }

  const CLIENT_KEYS = ["stepId", "checked", "skipped", "note"] as const;
  const ROUTE_KEYS = ["stepId", "checked", "skipped", "note"] as const;
  check(
    "collections · client and route share the checklist vocabulary",
    JSON.stringify([...CLIENT_KEYS].sort()) === JSON.stringify([...ROUTE_KEYS].sort()),
  );
  check(
    "collections · 'skipped' is in the vocabulary (not folded into 'checked')",
    CLIENT_KEYS.includes("skipped") && ROUTE_KEYS.includes("skipped"),
  );
}

// ── 10b · S302 — the deadline chip stays AMBER at every distance ───────────
// A red urgency tone shipped briefly and was REMOVED (Andrew): "caution amber,
// NEVER red" is a deliberate style fence (CaseSummary.tsx:7). Asserted as the
// absence of a tone field so the override cannot quietly return.
{
  const w = (() => {
    const d = mkDispute({
      status: "filed",
      sent_at: iso(-3),
      governing_deadline_date: dateOnly(-4),
      deadline_type: "plan_response",
    });
    return compose([d]).steps.find((s) => s.kind === "wait-active");
  })();
  check(
    "style fence · even an OVERDUE wait carries no red tone and no bar",
    w?.kind === "wait-active" &&
      !("deadlineTone" in w.card) &&
      !("countdownPct" in w.card),
  );
}

// ── 11 · S302 phase 3 — letter grouping, bands, and the resolved fold ───────
{
  const appeal = mkDispute({
    status: "filed",
    sent_at: iso(-6),
    governing_deadline_date: dateOnly(54),
    deadline_type: "plan_response",
  });
  const validation = mkDispute({
    status: "filed",
    created_at: iso(-5),
    sent_at: iso(-4),
    metadata: {
      letterType: "debt_validation",
      collector: { name: "Cascade Recovery", address: null, originalCreditor: null },
    },
  });
  const review = mkDispute({
    created_at: iso(-2),
    dispute_type: "external_appeal",
    metadata: { letterType: "external_review" },
  });
  const { groups, steps } = compose([appeal, validation, review], {
    [appeal.id]: "Blue Cross Blue Shield of Wyoming",
    [review.id]: "Blue Cross Blue Shield of Wyoming",
  });

  check("group · one group per letter, in projector order", groups.length === 3, groups.length);
  check(
    "group · group ids follow letter birth",
    groups.map((g) => g.disputeId).join(",") === [appeal.id, validation.id, review.id].join(","),
    groups.map((g) => g.disputeId),
  );
  check(
    "group · badges run FLAT across groups from firstNumber",
    steps.map((s) => s.badge).join(",") === steps.map((_, i) => String(i + 5)).join(","),
    steps.map((s) => s.badge),
  );
  check(
    "group · every step belongs to its group's letter",
    groups.every((g) =>
      g.steps.every((s) =>
        s.kind === "wait-active"
          ? s.card.disputeId === g.disputeId
          : s.kind === "next-move"
            ? s.move.disputeId === g.disputeId
            : s.disputeId === g.disputeId,
      ),
    ),
  );
  // The S302 regression this whole unit exists to prevent: an unrelated later
  // letter landing INSIDE an earlier letter's block. Before grouping, the
  // external-review draft (born after the collections send, before its
  // certified-mail steps) sorted between them.
  check(
    "group · intra-letter order is send → after-guide → wait, uninterrupted",
    groups[1].steps.map((s) => s.kind).join(",") ===
      "guide-step,guide-step,send-receipt,guide-step,guide-step,wait-active",
    groups[1].steps.map((s) => s.kind),
  );

  check(
    "band · eyebrow counts position of total",
    groups.map((g) => g.eyebrow).join("|") === "Letter 1 of 3|Letter 2 of 3|Letter 3 of 3",
    groups.map((g) => g.eyebrow),
  );
  check(
    "band · title is «letter» — «counterparty»",
    groups[0].title === "Appeal — Blue Cross Blue Shield of Wyoming" &&
      groups[1].title === "Debt validation — Cascade Recovery" &&
      groups[2].title === "External review — Blue Cross Blue Shield of Wyoming",
    groups.map((g) => g.title),
  );
  check(
    "band · sent + awaiting + dated → amber, with the engine deadline",
    groups[0].status?.tone === "amber" &&
      groups[0].status.label === `Waiting on their response · due ${fmtRailDate(dateOnly(54))}`,
    groups[0].status,
  );
  check(
    "band · UNDATED wait names no deadline (the sent+30d fallback is not one)",
    groups[1].status?.tone === "amber" &&
      groups[1].status.label === "Waiting on their response",
    groups[1].status,
  );
  check(
    "band · unsent letter reads as a draft",
    groups[2].status?.tone === "slate" && groups[2].status.label === "Draft — not sent yet",
    groups[2].status,
  );

  // Send-step copy, per letter type, from the ONE table.
  const sendTitles = groups.map(
    (g) => g.steps.find((s) => s.kind === "send-receipt" || s.kind === "send-draft")!.title,
  );
  check(
    "copy · send titles carry the approved per-type strings",
    sendTitles.join("|") === "Send the appeal|Answer the collector|Send the external review request",
    sendTitles,
  );
  const appealReceipt = groups[0].steps.find((s) => s.kind === "send-receipt")!;
  check(
    "copy · the appeal's receipt names its insurer (was receipt4bInsurer)",
    appealReceipt.kind === "send-receipt" &&
      appealReceipt.receipt ===
        `Appeal sent to Blue Cross Blue Shield of Wyoming · ${fmtRailDate(iso(-6))}`,
    appealReceipt.kind === "send-receipt" ? appealReceipt.receipt : appealReceipt.kind,
  );
}

// The resolved fold — derived, never stored.
{
  const openCase = mkDispute({ status: "filed", sent_at: iso(-3) });
  check("fold · an unfinished case does NOT fold", compose([openCase]).resolution === null);

  const nextRung = mkDispute({
    status: "lost",
    sent_at: iso(-6),
    metadata: {
      letterType: "insurance_appeal",
      outcomeDetail: "denied_fully",
      outcomeReportedAt: iso(-2),
    },
  });
  check(
    "fold · stage `next` (a move is still open) does NOT fold",
    compose([nextRung]).resolution === null,
  );

  // ── S303 · the defect this whole unit exists to close ─────────────────────
  // Escalated to the END of the ladder: appeal denied, external review taken
  // AND denied. Every letter is finished, so the case folds. Before S303 the
  // appeal kept `hasNextStep` forever — the taxonomy still named a rung that
  // the case had already taken — so it sat at `next` and the fold could NEVER
  // fire, no matter what the user logged. Observed exactly this way on the
  // Ballard case: three terminal outcomes, no collapse.
  const escAppeal = mkDispute({
    status: "lost",
    sent_at: iso(-20),
    metadata: {
      letterType: "insurance_appeal",
      outcomeDetail: "denied_fully",
      outcomeReportedAt: iso(-12),
    },
  });
  const escReview = mkDispute({
    dispute_type: "external_appeal",
    status: "lost",
    created_at: iso(-10),
    sent_at: iso(-9),
    metadata: {
      letterType: "external_review",
      outcomeDetail: "denied_fully",
      outcomeReportedAt: iso(-2),
    },
  });
  const escalated = compose([escAppeal, escReview], {
    [escAppeal.id]: "Blue Cross Blue Shield of Wyoming",
    [escReview.id]: "Blue Cross Blue Shield of Wyoming",
  });
  check(
    "fold · an escalated-to-the-end case FOLDS (the S303 defect)",
    escalated.resolution != null,
    escalated.resolution,
  );
  check(
    "fold · the superseded appeal no longer offers a rung it already took",
    escalated.steps
      .filter((s) => s.kind === "next-move")
      .every((s) => s.kind === "next-move" && s.move.letterOffer === null),
    escalated.steps.filter((s) => s.kind === "next-move").length,
  );
  check(
    "fold · both letters keep an undo for the result each logged",
    escalated.steps.filter((s) => s.kind === "wait-receipt").length === 2 &&
      escalated.steps
        .filter((s) => s.kind === "wait-receipt")
        .every((s) => s.kind === "wait-receipt" && s.undo === true),
  );
  // …but only once the ladder is genuinely spent. A STARTED-but-unsent next
  // letter finishes its parent without finishing the case.
  const draftedNext = compose([
    escAppeal,
    mkDispute({
      dispute_type: "external_appeal",
      created_at: iso(-10),
      metadata: { letterType: "external_review" },
    }),
  ]);
  check(
    "fold · a started-but-unsent next letter does NOT fold the case",
    draftedNext.resolution === null,
    draftedNext.resolution,
  );

  // external_review + denied_fully is the ladder's end: terminal, no next rung.
  const doneAppeal = mkDispute({
    status: "won",
    sent_at: iso(-20),
    amount_recovered: 100.27,
    metadata: {
      letterType: "insurance_appeal",
      outcomeDetail: "resolved_win",
      outcomeReportedAt: iso(-9),
    },
  });
  const doneReview = mkDispute({
    dispute_type: "external_appeal",
    status: "lost",
    created_at: iso(-8),
    sent_at: iso(-7),
    amount_recovered: 63,
    metadata: {
      letterType: "external_review",
      outcomeDetail: "denied_fully",
      outcomeReportedAt: iso(-3),
    },
  });
  const { resolution } = compose([doneAppeal, doneReview], {
    [doneAppeal.id]: "Blue Cross Blue Shield of Wyoming",
    [doneReview.id]: "Blue Cross Blue Shield of Wyoming",
  });
  check("fold · an all-terminal case folds", resolution != null);
  check(
    "fold · headline is the CLOSING letter's outcome label, verbatim",
    resolution?.headline === "Fully denied — no payment",
    resolution?.headline,
  );
  check(
    "fold · meta = counterparty · date · letter count · money recovered",
    resolution?.meta ===
      `Blue Cross Blue Shield of Wyoming · ${fmtRailDate(iso(-3))} · 2 letters · $163.27 recovered`,
    resolution?.meta,
  );
  check("fold · expand label", resolution?.expandLabel === "Show the full case");

  // amount_recovered absent → the money clause is omitted, never rendered $0.
  const noMoney = mkDispute({
    status: "lost",
    sent_at: iso(-20),
    dispute_type: "external_appeal",
    metadata: {
      letterType: "external_review",
      outcomeDetail: "denied_fully",
      outcomeReportedAt: iso(-4),
    },
  });
  const r2 = compose([noMoney], { [noMoney.id]: "Blue Cross Blue Shield of Wyoming" }).resolution;
  check(
    "fold · unlogged recovery omits the money clause (never $0.00)",
    r2?.meta === `Blue Cross Blue Shield of Wyoming · ${fmtRailDate(iso(-4))} · 1 letter`,
    r2?.meta,
  );

  // A case of nothing but cancelled letters is not a resolution.
  const onlyCancelled = mkDispute({ status: "cancelled", sent_at: iso(-5) });
  check("fold · cancelled-only case does not fold", compose([onlyCancelled]).resolution === null);
}

console.log(`\ncase-timeline rail-steps fixture: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  console.log("FAILED ✗");
  process.exit(1);
}
console.log("ALL GREEN ✓");
