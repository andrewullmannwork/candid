/**
 * case-timeline projector — Phase 0 fixture (S298, mig 221).
 *
 * Locks the projector's parity contract + sequence semantics BEFORE any UI
 * consumer exists:
 *   - stage parity: computeCaseStage inputs derived exactly like the dispute
 *     page (outcomeDetail-gated suggestNextStep)
 *   - responseDueDate parity: governing ?? sent+30d (persist.ts semantics)
 *   - sentLetterMeta parity: asserted EQUAL to the client deriveSentLetterMeta
 *     on identical data (the S297 seed the projector folds in)
 *   - §0.9 version semantics: send→unsend→resend counts; row stays the
 *     current-state authority for latestSendAt
 *   - dual concurrent waits (agenda §0.9a rule 2): two awaiting steps, per-step
 *     clocks, soonest-due aggregation
 *   - escalate chain: denied → stage `next` outranks resolved; synthesized
 *     `escalated` event lands on the PARENT dispute
 *   - phone-resolved + never-any-letter cases (§0: the rail must work with no
 *     letter ever)
 *   - stored∪virtual dedupe: exact (kind, disputeId, occurred_at) collapses,
 *     stored wins
 *   - synthesis exclusions: deadline_lapsed / followup_sent are never
 *     synthesized (cron owns lapse judgment; followups carry no send moment)
 *
 * Run:  npx tsx scripts/calibration/fixtures/case-timeline/projector.ts
 */
import {
  projectCaseTimeline,
  synthesizeCaseEventsFromRows,
  deriveSentLetterMetaParity,
  deriveResponseDueDate,
  resolveLetterType,
  type ProjectorClaimRow,
  type ProjectorDisputeRow,
  type ProjectorEventRow,
} from "../../../../src/lib/case/timeline-projector";
import { deriveSentLetterMeta } from "../../../../src/lib/claims/use-claim-pipeline";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}${got !== undefined ? `  (got: ${JSON.stringify(got)})` : ""}`);
}

const NOW = new Date();
const iso = (offsetDays: number, ms = 0) =>
  new Date(NOW.getTime() + offsetDays * 86_400_000 + ms).toISOString();
const dateOnly = (offsetDays: number) => iso(offsetDays).slice(0, 10);

const CLAIM = "11111111-1111-1111-1111-111111111111";

function mkClaim(metadata: Record<string, unknown> | null = null): ProjectorClaimRow {
  return { id: CLAIM, created_at: iso(-30), metadata };
}
let disputeSeq = 0;
function mkDispute(over: Partial<ProjectorDisputeRow>): ProjectorDisputeRow {
  disputeSeq++;
  return {
    id: `d${disputeSeq}`.padEnd(8, "0"),
    claim_id: CLAIM,
    dispute_type: "internal_appeal",
    status: "dispute_letter_drafted",
    created_at: iso(-10, disputeSeq * 1000),
    filed_date: null,
    resolution_date: null,
    sent_at: null,
    governing_deadline_date: null,
    deadline_type: null,
    metadata: { letterType: "insurance_appeal" },
    ...over,
  };
}
const ev = (
  kind: string,
  disputeId: string | null,
  occurredAt: string,
  payload: Record<string, unknown> = {},
  actor = "user",
): ProjectorEventRow => ({ kind, actor, occurred_at: occurredAt, dispute_id: disputeId, payload });

const project = (
  claim: ProjectorClaimRow,
  disputes: ProjectorDisputeRow[],
  events: ProjectorEventRow[] = [],
  amberDays = 7,
) => projectCaseTimeline({ claim, disputes, events, now: NOW, amberDays });

// ── 1 · letter-type + responseDueDate parity primitives ─────────────────────
{
  const meta = mkDispute({ metadata: { letterType: "debt_validation" } });
  check("resolveLetterType · metadata wins", resolveLetterType(meta) === "debt_validation");
  const legacy = mkDispute({ metadata: null, dispute_type: "internal_appeal" });
  check("resolveLetterType · legacy internal_appeal → insurance_appeal", resolveLetterType(legacy) === "insurance_appeal");
  // S298 consolidation + correction (one shared resolver, letter-type.ts):
  // legacy external_appeal now maps to external_review — the insurer track's
  // TERMINAL letter, not its first rung (the old GET guess would offer a
  // denied legacy external review an escalation to itself).
  const legacyExternal = mkDispute({ metadata: null, dispute_type: "external_appeal" });
  check("resolveLetterType · CORRECTED: legacy external_appeal → external_review", resolveLetterType(legacyExternal) === "external_review");
  const legacyComplaint = mkDispute({ metadata: null, dispute_type: "complaint" });
  check("resolveLetterType · legacy complaint → balance_billing (GET side of the drift, kept)", resolveLetterType(legacyComplaint) === "balance_billing");
  const unknown = mkDispute({ metadata: null, dispute_type: "cost_share_misapplication" });
  check("resolveLetterType · unknown coerces to overcharge", resolveLetterType(unknown) === "overcharge");
  // The corrected mapping closes the track: a denied legacy external review
  // must offer NO next step (external_review exhausts the insurer ladder).
  {
    const t = project(mkClaim(), [mkDispute({
      metadata: null,
      dispute_type: "external_appeal",
      status: "lost",
      sent_at: iso(-10),
    })]);
    // No outcomeDetail on this legacy row → hasNextStep false by the page rule;
    // with one logged, the exhausted track still offers none:
    const t2 = project(mkClaim(), [mkDispute({
      metadata: { outcomeDetail: "denied_fully", outcomeReportedAt: iso(-1) },
      dispute_type: "external_appeal",
      status: "lost",
      sent_at: iso(-10),
    })]);
    check("resolveLetterType · corrected mapping: denied legacy external review offers NO next step", t.letters[0].hasNextStep === false && t2.letters[0].hasNextStep === false && t2.letters[0].stage === "resolved", { t: t.letters[0].stage, t2: t2.letters[0].stage });
  }

  const governed = mkDispute({ governing_deadline_date: "2026-09-29", sent_at: iso(-6) });
  check("responseDueDate · governing wins", deriveResponseDueDate(governed) === "2026-09-29");
  const sentOnly = mkDispute({ sent_at: iso(-6) });
  check(
    "responseDueDate · sent+30d fallback",
    deriveResponseDueDate(sentOnly) === iso(24).slice(0, 10),
    deriveResponseDueDate(sentOnly),
  );
  check("responseDueDate · null when neither", deriveResponseDueDate(mkDispute({})) === null);
}

// ── 2 · single awaiting letter (the real Ballard shape) ─────────────────────
{
  const d = mkDispute({
    status: "filed",
    sent_at: iso(-6),
    governing_deadline_date: dateOnly(54),
    deadline_type: "plan_response",
  });
  const t = project(mkClaim(), [d]);
  check("awaiting · one letter", t.letters.length === 1);
  check("awaiting · stage", t.letters[0].stage === "awaiting", t.letters[0].stage);
  check("awaiting · recipientKind insurer", t.letters[0].recipientKind === "insurer");
  check("awaiting · waitingCount 1", t.waitingCount === 1);
  check("awaiting · soonest due = governing", t.soonestResponseDue?.date === dateOnly(54));
  check("awaiting · sendCount from synthesis", t.letters[0].sendCount === 1, t.letters[0].sendCount);
  check("awaiting · meta not amber at 54d/7d", t.sentLetterMeta?.amber === false);
  const kinds = t.history.map((h) => h.kind);
  check("awaiting · history has drafted+sent", kinds.includes("letter_drafted") && kinds.includes("letter_sent"));
  check("awaiting · history chronological", kinds.indexOf("letter_drafted") < kinds.indexOf("letter_sent"));
}

// ── 3 · §0.9 Case 1: send → unsend → resend ─────────────────────────────────
{
  const d = mkDispute({ status: "filed", sent_at: iso(-1) });
  const events = [
    ev("letter_sent", d.id, iso(-3)),
    ev("letter_unsent", d.id, iso(-2)),
    ev("letter_sent", d.id, iso(-1)),
  ];
  const t = project(mkClaim(), [d], events);
  const l = t.letters[0];
  check("versions · sendCount 2", l.sendCount === 2, l.sendCount);
  check("versions · unsendCount 1", l.unsendCount === 1, l.unsendCount);
  check("versions · row is latest-send authority", l.latestSendAt === d.sent_at);
  check("versions · stage awaiting after resend", l.stage === "awaiting");
  // The stored letter_sent at iso(-1) and the row synthesis of sent_at iso(-1)
  // are the same moment — dedupe must collapse them (stored wins).
  const sentEntries = t.history.filter((h) => h.kind === "letter_sent");
  check("dedupe · stored beats virtual twin", sentEntries.length === 2 && sentEntries.every((e) => !e.virtual), sentEntries.length);
}

// ── 4 · dual concurrent waits (agenda §0.9a rule 2) ─────────────────────────
{
  const appeal = mkDispute({
    status: "filed",
    sent_at: iso(-20),
    governing_deadline_date: dateOnly(40),
    deadline_type: "plan_response",
  });
  const debt = mkDispute({
    dispute_type: "debt_validation",
    metadata: { letterType: "debt_validation", collectorFirstContactDate: dateOnly(-2) },
    status: "filed",
    sent_at: iso(-1),
    governing_deadline_date: dateOnly(28),
    deadline_type: "fdcpa_validation_30",
  });
  const t = project(mkClaim(), [appeal, debt]);
  check("dual · two letters", t.letters.length === 2);
  check("dual · both awaiting", t.waitingCount === 2, t.waitingCount);
  check("dual · chronological by start", t.letters[0].disputeId === appeal.id);
  check("dual · soonest = debt's 28d", t.soonestResponseDue?.date === dateOnly(28) && t.soonestResponseDue?.disputeId === debt.id);
  check("dual · per-step clocks intact", t.letters[0].responseDueDate === dateOnly(40) && t.letters[1].responseDueDate === dateOnly(28));
  check("dual · debt synthesis includes collections_reported", t.history.some((h) => h.kind === "collections_reported" && h.disputeId === debt.id));
  check("dual · meta earliest due", t.sentLetterMeta?.responseDueDate === dateOnly(28));
}

// ── 5 · escalate chain: denied → next outranks resolved ─────────────────────
{
  const appeal = mkDispute({
    status: "lost",
    sent_at: iso(-30),
    metadata: {
      letterType: "insurance_appeal",
      outcomeDetail: "denied_fully",
      outcomeReportedAt: iso(-5),
    },
  });
  const external = mkDispute({
    dispute_type: "external_appeal",
    status: "dispute_letter_drafted",
    created_at: iso(-2),
    metadata: { letterType: "external_review", escalatedFromDisputeId: appeal.id },
  });
  const t = project(mkClaim(), [appeal, external]);
  const a = t.letters.find((l) => l.disputeId === appeal.id)!;
  const x = t.letters.find((l) => l.disputeId === external.id)!;
  check("chain · denied appeal has next step", a.hasNextStep === true);
  check("chain · stage next outranks resolved", a.stage === "next", a.stage);
  check("chain · outcome carried", a.outcome?.detail === "denied_fully" && a.outcome.loggedAt === iso(-5));
  check("chain · child stage draft", x.stage === "draft");
  check("chain · escalated event lands on PARENT", t.history.some((h) => h.kind === "escalated" && h.disputeId === appeal.id && h.payload.toDisputeId === external.id));
  check("chain · response_logged synthesized", t.history.some((h) => h.kind === "response_logged" && h.disputeId === appeal.id));
  check("chain · waitingCount 0 (next+draft)", t.waitingCount === 0, t.waitingCount);
  // External review exhausts the insurer track: a denied external_review offers no next.
  const exhausted = mkDispute({
    dispute_type: "external_appeal",
    status: "lost",
    sent_at: iso(-1),
    metadata: { letterType: "external_review", outcomeDetail: "denied_fully", outcomeReportedAt: iso(0) },
  });
  const t2 = project(mkClaim(), [exhausted]);
  check("chain · exhausted track → resolved", t2.letters[0].stage === "resolved", t2.letters[0].stage);
}

// ── 6 · phone-resolved + never-any-letter (§0: no letter ever) ──────────────
{
  const claim = mkClaim({
    guideSteps: {
      "packA:ins-call-insurer": { checkedAt: iso(-4), note: "Ref 12345" },
      "packA:ins-ask-hold": { checkedAt: iso(-4, 60_000) },
      "packA:phone-outcome": { checkedAt: iso(-3), note: "yes" },
    },
  });
  const t = project(claim, []);
  check("phone · zero letters", t.letters.length === 0);
  check("phone · meta null", t.sentLetterMeta === null);
  check("phone · attested events", t.history.filter((h) => h.kind === "guide_step_attested").length === 2);
  const po = t.history.find((h) => h.kind === "phone_outcome_answered");
  check("phone · outcome answer enum in payload", po?.payload.answer === "yes");
  check("phone · note text NEVER in payload", !JSON.stringify(t.history).includes("Ref 12345"));
  check("phone · hasNote boolean carried", t.history.some((h) => h.kind === "guide_step_attested" && h.payload.hasNote === true));

  const empty = project(mkClaim(), []);
  check("empty · clean claim projects empty", empty.letters.length === 0 && empty.history.length === 0 && empty.waitingCount === 0);
}

// ── 7 · sentLetterMeta parity vs the client hook (same data, same clock) ────
{
  const rows = [
    mkDispute({ status: "filed", sent_at: iso(-6), governing_deadline_date: dateOnly(3) }),
    mkDispute({ status: "filed", sent_at: iso(-2), governing_deadline_date: dateOnly(40) }),
    mkDispute({ status: "cancelled", sent_at: iso(-1), governing_deadline_date: dateOnly(1) }),
  ];
  const mine = deriveSentLetterMetaParity(rows, NOW, 7);
  const client = deriveSentLetterMeta(
    rows.map((d) => ({
      id: d.id,
      disputeType: d.dispute_type,
      status: d.status,
      amountDisputed: 0,
      amountRecovered: 0,
      filedDate: d.filed_date ?? "",
      resolutionDate: d.resolution_date,
      claimId: d.claim_id,
      sentAt: d.sent_at,
      responseDueDate: deriveResponseDueDate(d),
    })),
    CLAIM,
    7,
  );
  check("meta-parity · responseDueDate equal", mine?.responseDueDate === client?.responseDueDate, { mine, client });
  check("meta-parity · amber equal", mine?.amber === client?.amber, { mine, client });
  check("meta-parity · daysRemaining equal", mine?.daysRemaining === client?.daysRemaining, { mine, client });
  check("meta-parity · cancelled excluded (due=3d not 1d)", mine?.responseDueDate === dateOnly(3));
  check("meta-parity · amber at 3d/7d", mine?.amber === true);
  const none = deriveSentLetterMetaParity([mkDispute({})], NOW, 7);
  const clientNone = deriveSentLetterMeta([], CLAIM, 7);
  check("meta-parity · nothing sent → null (both)", none === null && clientNone === null);
}

// ── 8 · synthesis exclusions ────────────────────────────────────────────────
{
  const d = mkDispute({
    status: "filed",
    sent_at: iso(-40),
    governing_deadline_date: dateOnly(-10), // already lapsed
  });
  const synth = synthesizeCaseEventsFromRows(mkClaim(), [d]);
  const kinds = synth.map((s) => s.kind);
  check("exclusions · no deadline_lapsed synthesized", !kinds.includes("deadline_lapsed"));
  check("exclusions · no followup_sent synthesized", !kinds.includes("followup_sent"));
  check("exclusions · redrafts synthesized from history", (() => {
    const withRedrafts = mkDispute({ metadata: { letterType: "insurance_appeal", redraftHistory: [iso(-3), iso(-2)] } });
    return synthesizeCaseEventsFromRows(mkClaim(), [withRedrafts]).filter((s) => s.kind === "letter_redrafted").length === 2;
  })());
  const t = project(mkClaim(), [mkDispute({ metadata: { letterType: "insurance_appeal", redraftHistory: [iso(-3)] } })]);
  check("exclusions · redraftCount wired", t.letters[0].redraftCount === 1);
}

// ── 9 · S299 phase-1a per-letter display fields ─────────────────────────────
// counterpartyName (collector letters only) + mailedCertified (checklist
// attest). Deliberately NO day-count checks here: the projector carries no
// calendars (it runs server-side in UTC while the user's calendar is local —
// the S299 "sent Jul 31 vs Jul 30" lesson); day-math lives client-side and is
// exercised in fixtures/case-timeline/rail-steps.ts with an injected clock.
{
  const collector = project(mkClaim(), [
    mkDispute({
      status: "filed",
      sent_at: iso(-1),
      metadata: {
        letterType: "debt_validation",
        collector: { name: "Cascade Recovery", address: null, originalCreditor: null },
        checklist: { mailcert: true },
      },
    }),
  ]);
  check(
    "s299 · counterpartyName from metadata.collector.name",
    collector.letters[0].counterpartyName === "Cascade Recovery",
  );
  check("s299 · mailedCertified from checklist attest", collector.letters[0].mailedCertified === true);

  const insurerLetter = project(mkClaim(), [
    mkDispute({
      status: "filed",
      sent_at: iso(-1),
      metadata: { letterType: "insurance_appeal", collector: { name: "X" } },
    }),
  ]);
  check(
    "s299 · counterpartyName null on non-collector letters",
    insurerLetter.letters[0].counterpartyName === null,
  );
  check("s299 · mailedCertified defaults false", insurerLetter.letters[0].mailedCertified === false);
}

console.log(`\ncase-timeline projector fixture: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  console.log("FAILED ✗");
  process.exit(1);
}
console.log("ALL GREEN ✓");
