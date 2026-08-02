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
  planFollowupQuieting,
  type ActiveFollowup,
  type PendingFollowupRow,
} from "../../../../src/lib/disputes/followups";

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
  opts: { provider?: string | null; deadline?: string | null } = {},
): ActiveFollowup {
  return {
    id,
    dispute_id: disputeId,
    user_id: "u1",
    followup_type: "initial_30d",
    due_date: "2026-08-01",
    status: "pending",
    escalation_type: null,
    metadata: {},
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
  ]);
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
  ]);
  check("group · two nudges on one letter → letterCount 1", groups[0].letterCount === 1, groups[0].letterCount);
  check("group · both ids still dismissible", groups[0].followupIds.length === 2);
}

// A followup whose dispute has no claim would render a button to nowhere.
{
  const groups = groupFollowupsByClaim([row("f1", "d1", null), row("f2", "d2", "c1")]);
  check("group · claim-less rows are DROPPED, not null-bucketed", groups.length === 1 && groups[0].claimId === "c1", groups);
}

{
  check("group · empty input → empty", groupFollowupsByClaim([]).length === 0);
}

// Provider name backfills from a later row when the first lacks one.
{
  const groups = groupFollowupsByClaim([
    row("f1", "d1", "c1", { provider: null }),
    row("f2", "d2", "c1", { provider: "Ballard Clinic" }),
  ]);
  check("group · provider name backfills from a later row", groups[0].providerName === "Ballard Clinic", groups[0].providerName);
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
