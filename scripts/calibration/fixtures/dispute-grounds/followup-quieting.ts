/**
 * followup grouping + quieting fixture (S300 phase 2b).
 *
 * Two pure contracts behind the banner going pure-pointer:
 *
 * 1. `groupFollowupsByClaim` — ONE CLAIM PER POINTER (§0.9c). One row per bill,
 *    letters counted DISTINCTLY (a letter with two pending nudges is still one
 *    letter waiting), soonest deadline, claim-less rows dropped rather than
 *    bucketed under a null key (their only affordance is a claim deeplink).
 *
 * 2. `planFollowupQuieting` — what a logged response does to the nudge chain.
 *    The banner's "Still waiting" button is gone, so this rule is now the ONLY
 *    thing standing between a user who logs "they asked for more information"
 *    and being asked "did you hear back?" forever. It RE-ANCHORS rather than
 *    cancels: those cases are still open, and going dark on them would lose the
 *    outcome that feeds the flywheel.
 *
 * Run:  npx tsx scripts/calibration/fixtures/dispute-grounds/followup-quieting.ts
 */
import {
  groupFollowupsByClaim,
  planDeadlineReasserts,
  planFollowupQuieting,
  type ActiveFollowup,
  type PendingFollowupRow,
} from "../../../../src/lib/disputes/followups";

/** Injected clock — every date assertion below is relative to this. */
const TODAY = "2026-08-03";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}${got !== undefined ? `  (got: ${JSON.stringify(got)})` : ""}`);
}

function row(
  id: string,
  disputeId: string,
  claimId: string | null,
  opts: { provider?: string | null; deadline?: string | null; kind?: string } = {},
): ActiveFollowup {
  return {
    id,
    dispute_id: disputeId,
    user_id: "u1",
    followup_type: "initial_30d",
    due_date: "2026-08-01",
    status: "pending",
    escalation_type: null,
    metadata: opts.kind ? { followup_kind: opts.kind } : {},
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    dispute: {
      id: disputeId,
      dispute_type: "internal_appeal",
      status: "filed",
      amount_disputed: 0,
      filed_date: "2026-07-01",
      claim_id: claimId,
      // `?? ` would swallow an explicit null — the backfill case needs it through.
      provider_name: "provider" in opts ? opts.provider! : "Swedish Medical Center",
      governing_deadline_date: opts.deadline ?? null,
    },
  } as ActiveFollowup;
}

// ── Grouping ────────────────────────────────────────────────────────────────
{
  const groups = groupFollowupsByClaim([
    row("f1", "d1", "c1", { deadline: "2026-08-20" }),
    row("f2", "d2", "c1", { deadline: "2026-08-12" }),
    row("f3", "d3", "c2", { provider: "Ballard Clinic", deadline: null }),
  ], TODAY);
  check("group · one row per claim", groups.length === 2, groups.length);
  const c1 = groups.find((g) => g.claimId === "c1")!;
  check("group · counts DISTINCT letters", c1.letterCount === 2, c1.letterCount);
  check("group · soonest deadline wins", c1.nextDeadline === "2026-08-12", c1.nextDeadline);
  check("group · collects every followup id for the claim-scoped dismiss", c1.followupIds.join(",") === "f1,f2", c1.followupIds);
  check("group · provider name carried", c1.providerName === "Swedish Medical Center");
  const c2 = groups.find((g) => g.claimId === "c2")!;
  check("group · no deadline → null (row renders without the clause)", c2.nextDeadline === null);
  check("group · input due-date order preserved (most urgent claim leads)", groups[0].claimId === "c1");
}

// Two nudges on ONE letter is still one letter waiting.
{
  const groups = groupFollowupsByClaim([
    row("f1", "d1", "c1"),
    row("f2", "d1", "c1"),
  ], TODAY);
  check("group · two nudges on one letter → letterCount 1", groups[0].letterCount === 1, groups[0].letterCount);
  check("group · both ids still dismissible", groups[0].followupIds.length === 2);
}

// A followup whose dispute has no claim would render a button to nowhere.
{
  const groups = groupFollowupsByClaim([row("f1", "d1", null), row("f2", "d2", "c1")], TODAY);
  check("group · claim-less rows are DROPPED, not null-bucketed", groups.length === 1 && groups[0].claimId === "c1", groups);
}

{
  check("group · empty input → empty", groupFollowupsByClaim([], TODAY).length === 0);
}

// Provider name backfills from a later row when the first lacks one.
{
  const groups = groupFollowupsByClaim([
    row("f1", "d1", "c1", { provider: null }),
    row("f2", "d2", "c1", { provider: "Ballard Clinic" }),
  ], TODAY);
  check("group · provider name backfills from a later row", groups[0].providerName === "Ballard Clinic", groups[0].providerName);
}

// ── Age-out: a deadline nudge whose deadline has PASSED stops rendering ─────
// (Andrew) — otherwise the banner asserts "next deadline Aug 12" on Aug 13,
// which reads as live and is worse than saying nothing.
{
  const groups = groupFollowupsByClaim(
    [row("f1", "d1", "c1", { deadline: "2026-08-01", kind: "deadline_interim" })],
    TODAY,
  );
  check("age-out · past-deadline nudge drops the whole row", groups.length === 0, groups);
}
{
  const groups = groupFollowupsByClaim(
    [
      row("f1", "d1", "c1", { deadline: "2026-08-01", kind: "deadline_interim" }),
      row("f2", "d2", "c1", { deadline: null }),
    ],
    TODAY,
  );
  check("age-out · the claim survives on its remaining check-in nudge", groups.length === 1, groups);
  check("age-out · and counts only the live letter", groups[0].letterCount === 1, groups[0].letterCount);
  check("age-out · the stale id is NOT offered to the dismiss call", groups[0].followupIds.join(",") === "f2", groups[0].followupIds);
}
{
  const groups = groupFollowupsByClaim(
    [row("f1", "d1", "c1", { deadline: TODAY, kind: "deadline_final" })],
    TODAY,
  );
  check("age-out · a deadline landing TODAY still renders (not yet past)", groups.length === 1, groups);
}
{
  const groups = groupFollowupsByClaim(
    [row("f1", "d1", "c1", { deadline: "2026-08-01" })],
    TODAY,
  );
  check("age-out · a CHECK-IN nudge is never aged out by a stale deadline", groups.length === 1, groups);
}

// ── Re-assert: the ✕ snoozes a deadline nudge, never deletes it ─────────────
// Andrew: "allow the x in all cases, but show the banner again 2 days and 1
// day before the deadline passes."
{
  check(
    "reassert · dismissed early → returns at deadline−2 and −1",
    planDeadlineReasserts("2026-09-01", TODAY).join(",") === "2026-08-30,2026-08-31",
    planDeadlineReasserts("2026-09-01", TODAY),
  );
  check(
    "reassert · dismissed ON deadline−2 → only −1 remains (strictly future)",
    planDeadlineReasserts("2026-08-05", TODAY).join(",") === "2026-08-04",
    planDeadlineReasserts("2026-08-05", TODAY),
  );
  check(
    "reassert · dismissed at deadline−1 → nothing; at that range it's a decision, not a deferral",
    planDeadlineReasserts("2026-08-04", TODAY).length === 0,
    planDeadlineReasserts("2026-08-04", TODAY),
  );
  check("reassert · deadline today → nothing", planDeadlineReasserts(TODAY, TODAY).length === 0);
  check("reassert · deadline already past → nothing", planDeadlineReasserts("2026-07-01", TODAY).length === 0);
  check("reassert · no deadline → nothing (check-in nudges dismiss for good)", planDeadlineReasserts(null, TODAY).length === 0);
  check("reassert · malformed date → nothing, never a crash", planDeadlineReasserts("not-a-date", TODAY).length === 0);
  check(
    "reassert · month boundary math holds",
    planDeadlineReasserts("2026-09-01", "2026-08-28").join(",") === "2026-08-30,2026-08-31",
    planDeadlineReasserts("2026-09-01", "2026-08-28"),
  );
}

// ── Quieting ────────────────────────────────────────────────────────────────
const pend = (id: string, type: PendingFollowupRow["followup_type"], kind?: string): PendingFollowupRow => ({
  id,
  followup_type: type,
  metadata: kind ? { followup_kind: kind } : {},
});

{
  const plan = planFollowupQuieting([pend("f1", "initial_30d")], "needs_info");
  check("quiet · an OPEN outcome dismisses the stale nudge", plan.dismissIds.join(",") === "f1");
  check("quiet · and re-anchors to the next rung", plan.nextType === "reprompt_14d", plan.nextType);
}

{
  const plan = planFollowupQuieting([pend("f1", "reprompt_14d")], "denied_counteroffer");
  check("quiet · reprompt escalates to final, never back to reprompt", plan.nextType === "final", plan.nextType);
}

{
  const plan = planFollowupQuieting([pend("f1", "final")], "new_problem");
  check("quiet · the cadence ENDS at final (no infinite nagging)", plan.nextType === null, plan.nextType);
  check("quiet · final is still dismissed", plan.dismissIds.join(",") === "f1");
}

{
  const plan = planFollowupQuieting([pend("f1", "initial_30d"), pend("f2", "reprompt_14d")], "collections");
  check("quiet · re-anchor uses the FURTHEST-ALONG dismissed row", plan.nextType === "final", plan.nextType);
  check("quiet · every check-in row dismissed", plan.dismissIds.sort().join(",") === "f1,f2");
}

{
  const plan = planFollowupQuieting([pend("f1", "initial_30d")], "no_response");
  check("quiet · 'no response yet' leaves the chain ALONE (they truly haven't heard)", plan.dismissIds.length === 0 && plan.nextType === null, plan);
}

{
  const plan = planFollowupQuieting(
    [pend("f1", "reprompt_14d", "deadline_interim"), pend("f2", "final", "deadline_final")],
    "needs_info",
  );
  check("quiet · DEADLINE rows are never touched by an outcome", plan.dismissIds.length === 0 && plan.nextType === null, plan);
}

{
  const plan = planFollowupQuieting(
    [pend("f1", "initial_30d"), pend("f2", "final", "deadline_final")],
    "needs_info",
  );
  check("quiet · mixed set dismisses ONLY the check-in row", plan.dismissIds.join(",") === "f1", plan.dismissIds);
  check("quiet · mixed set still re-anchors the check-in chain", plan.nextType === "reprompt_14d");
}

{
  check("quiet · nothing pending → no-op", planFollowupQuieting([], "needs_info").dismissIds.length === 0);
}

console.log(`\nfollowup grouping + quieting fixture: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  console.log("FAILED ✗");
  process.exit(1);
}
console.log("ALL GREEN ✓");
