/**
 * rail-steps — phase-1a composition fixture (S299).
 *
 * Locks the extension rail's contract BEFORE the DEV E2E:
 *   - chronological numbering after the prep rail (wait anchors at latest
 *     send; send-steps at row birth; primary letter's send step NEVER
 *     duplicated — it is 4b)
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
  composeRailSteps,
  railHasExtension,
  fmtRailDate,
  type RailStepModel,
} from "../../../../src/lib/case/rail-steps";
import { CASE_RAIL } from "../../../../src/lib/guides/pack-registry";

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

const compose = (
  disputes: ProjectorDisputeRow[],
  primaryDisputeId: string | null,
  insurerNameByDispute: Record<string, string> = {},
) => {
  const t = projectCaseTimeline({ claim: claimRow, disputes, events: [], now: NOW, amberDays: 7 });
  return {
    t,
    steps: composeRailSteps({
      letters: t.letters,
      primaryDisputeId,
      firstNumber: 5,
      insurerNameByDispute,
      providerName: "Swedish Primary Care Ballard",
      now: NOW,
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
  const { steps } = compose([appeal, validation], appeal.id, {
    [appeal.id]: "Providence Health Plan",
  });

  check("ballard · 3 steps (wait + send + wait)", steps.length === 3, steps.length);
  check("ballard · badges 5/6/7 chronological", steps.map((s) => s.badge).join(",") === "5,6,7", steps.map((s) => s.badge));
  const [s5, s6, s7] = steps;
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
    check("ballard · countdown 4/(4+19) → 17%", s7.card.countdownPct === 17, s7.card.countdownPct);
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
  const { t, steps } = compose([appeal, validation], appeal.id, {
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
  const { steps } = compose([appeal], appeal.id, { [appeal.id]: "Providence Health Plan" });
  const w = steps[0];
  check("overdue · still an active wait", w.kind === "wait-active");
  if (w.kind === "wait-active") {
    check(
      "overdue · passed chip",
      w.card.chipDeadline === `Their deadline: ${fmtRailDate(dateOnly(-2))} · passed`,
      w.card.chipDeadline,
    );
    check("overdue · bar pinned 100", w.card.countdownPct === 100);
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
  const { steps } = compose([validation], null);
  const w = steps.find((s) => s.kind === "wait-active");
  check("undated · wait renders", w != null);
  if (w && w.kind === "wait-active") {
    // responseDueDate carries the sent+30d display fallback — deadlineType is
    // null, so NO deadline is asserted (the fallback never becomes a claim).
    check("undated · no deadline chip", w.card.chipDeadline === null, w.card.chipDeadline);
    check("undated · pause chip", w.card.chipPause === CASE_RAIL.chipCollectionPause);
    check("undated · no countdown", w.card.countdownPct === null);
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
  const { steps } = compose([appeal, draftValidation], appeal.id, {});
  const draftStep = steps.find((s) => s.kind === "send-draft");
  check("draft · escalated draft renders an open-letter step", draftStep != null);
  check("draft · open-letter label", draftStep?.kind === "send-draft" && draftStep.openLetterLabel === "Open this letter");
  check("draft · no wait step for an unsent letter", steps.filter((s) => s.kind.startsWith("wait")).length === 1);
  check("draft · insurer fallback title", steps[0].title === "Waiting on your plan — your appeal", steps[0].title);

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
  const { steps: tzA } = compose([mkDispute({ status: "filed", sent_at: lateLastNight })], null);
  const tzWa = tzA.find((s) => s.kind === "wait-active");
  check(
    "tz · pre-local-midnight send → Sent 1 day ago",
    tzWa?.kind === "wait-active" && tzWa.card.chipSentAgo === "Sent 1 day ago",
    tzWa?.kind === "wait-active" ? tzWa.card.chipSentAgo : tzWa?.kind,
  );
  const { steps: tzB } = compose([mkDispute({ status: "filed", sent_at: earlyToday })], null);
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
  const { steps: pSteps } = compose([provider], provider.id, {});
  const pw = pSteps[0];
  check("omission · provider wait has no whn set", pw.kind === "wait-active" && pw.card.whn === null, pw.kind);
  check(
    // Noun comes from LETTER_TYPE_LABELS (one source, S299): overcharge's
    // label is "Billing Dispute" → "your billing dispute letter".
    "omission · provider wait generic title (label-sourced noun)",
    pw.title === "Waiting on Swedish Primary Care Ballard — your billing dispute letter",
    pw.title,
  );
}

// ── 6 · Extension predicate + cancelled rows ────────────────────────────────
{
  const draftPrimary = mkDispute({});
  const { t } = compose([draftPrimary], draftPrimary.id);
  check(
    "predicate · draft primary only → no extension",
    railHasExtension(t.letters, draftPrimary.id) === false,
  );
  const cancelled = mkDispute({ status: "cancelled", sent_at: iso(-3) });
  const { t: t2, steps: s2 } = compose([cancelled], null);
  check("predicate · cancelled contributes nothing", railHasExtension(t2.letters, null) === false && s2.length === 0);
  const sentPrimary = mkDispute({ status: "filed", sent_at: iso(-3) });
  const { t: t3 } = compose([sentPrimary], sentPrimary.id);
  check("predicate · sent primary → extension (its wait)", railHasExtension(t3.letters, sentPrimary.id) === true);
}

console.log(`\ncase-timeline rail-steps fixture: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  console.log("FAILED ✗");
  process.exit(1);
}
console.log("ALL GREEN ✓");
