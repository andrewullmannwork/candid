/**
 * execution-lock — while Candid is EXECUTING a matter, the member's own
 * execution actions are held (S331).
 *
 * The gap this closes: nothing, on the client or the server, stopped a member
 * from marking their appeal sent or redrafting it while an operator was
 * submitting the very same letter as their authorized representative. Two
 * submissions reach the plan, from the same person, and neither side knows.
 *
 * The lock is deliberately NARROW. Two things a member does are load-bearing
 * for the lane and must stay open:
 *
 *   · CHOOSING WHAT TO ARGUE. The engagement blocks on it — intake Gate 0
 *     requires the member composed the appeal themselves, and the route-layer
 *     invariant refuses operator execution without `ground_selected` +
 *     `letter_adopted`. Locking composition would deadlock every matter.
 *   · FILING AT THE STATE LEVEL. Gate 4 is `memberFilesAtStateLevel: true` by
 *     design: Candid prepares the packet, the member signs and files it. That
 *     is the service's shape, not a preference.
 *
 * So only the two actions where two hands genuinely collide are held: SENDING
 * (the operator transmits) and REDRAFTING (the letter is already in the plan's
 * hands). Logging an outcome stays open — the member may hear from the plan
 * directly — and so does undoing one.
 *
 * WHY IT KEYS ON `ACTIONABLE_STATUSES`: that is the set under which an operator
 * may act on a matter. The member's execution must be held over exactly the
 * statuses where the operator's is granted, so the two are read from ONE list
 * and can never drift apart.
 *
 * NOT part of `evaluateLetterAccess`: that gate also runs at GENERATE time, so
 * a hold placed there would block composition and deadlock the lane. This is a
 * different axis — access is "may you have this letter", this is "who is
 * executing it right now" — and it is applied at the two execution seams only.
 *
 * NOT part of `ReadinessBlocker` either: that gate means "something is missing
 * and here is how you fix it". Candid handling the letter is not a missing item
 * the member can go and supply.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { userScoped } from "@/lib/security/user-scoped";
import { ACTIONABLE_STATUSES, type EngagementStatus } from "./engagement-state";

/** The member actions Candid takes over while it is executing. */
export type HeldMemberAction = "send" | "redraft";

/** The 409 body's `error` code, so clients can branch on it. */
export const DFY_EXECUTION_HOLD_CODE = "dfy_execution_hold";

/** What the member reads. Approved copy (S331). */
export const DFY_EXECUTION_HOLD_MESSAGE: Readonly<Record<HeldMemberAction, string>> = {
  send: "Candid is handling this letter for you — there's nothing to send.",
  redraft: "Candid is handling this letter for you — we'll redraft it if it needs changing.",
};

/** The panel that replaces the send control on the rail. Approved copy (S331). */
export const DFY_EXECUTION_HOLD_PANEL = {
  title: "Candid is handling this letter.",
  body: "We submit it as your authorized representative and record what comes back. You'll see every step on this timeline.",
} as const;

/**
 * Is the member's execution held? PURE.
 *
 * @param status the engagement's status on this claim, or null when there is
 *               no engagement at all (the overwhelmingly common case).
 */
export function dfyExecutionHeld(status: EngagementStatus | null | undefined): boolean {
  return status != null && ACTIONABLE_STATUSES.includes(status);
}

/**
 * Does this claim have a matter Candid is currently executing? The server-side
 * question, asked at the two execution seams.
 *
 * Fail-OPEN on a read error, matching the send gate's own posture: a monitoring
 * failure must never become a wall between a member and their own letter. The
 * cost of a rare double-send is lower than the cost of locking someone out of
 * their appeal because a query timed out.
 */
export async function claimUnderDfyExecution(
  supabase: SupabaseClient,
  userId: string,
  claimId: string | null,
): Promise<boolean> {
  if (!claimId) return false;
  try {
    const { data, error } = await userScoped(supabase, userId)
      .table("dfy_engagements")
      .select("status")
      .eq("claim_id", claimId)
      .in("status", ACTIONABLE_STATUSES)
      .limit(1);
    if (error) {
      console.error("[dfy execution-lock] engagement read failed; failing open:", error);
      return false;
    }
    return (data ?? []).length > 0;
  } catch (err) {
    console.error("[dfy execution-lock] engagement read threw; failing open:", err);
    return false;
  }
}

/** The 409 body for a held action — one shape, both seams. */
export function dfyExecutionHoldResponse(action: HeldMemberAction): {
  error: string;
  reason: string;
} {
  return { error: DFY_EXECUTION_HOLD_CODE, reason: DFY_EXECUTION_HOLD_MESSAGE[action] };
}
