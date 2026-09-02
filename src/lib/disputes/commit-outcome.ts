/**
 * commit-outcome — THE one place a dispute's outcome is recorded (S331).
 *
 * Before this module the member's own report (/api/disputes/outcome) and the
 * DFY operator's "Record determination" wrote two different things:
 *
 *   member   → dispute_outcomes.status + metadata.outcomeDetail/outcomeReportedAt
 *              + response_logged + follow-up quieting          (the real home)
 *   operator → dispute_outcomes.metadata.dfy_determination      (a private key
 *              nothing reads: no rail step, no status change, no follow-up
 *              quieting, no accuracy scoring, no escalation door)
 *
 * One fact, two homes, two vocabularies — so an operator-recorded determination
 * was invisible to the member and invisible to the flywheel. Everything that
 * could drift between the two callers lives here now: the metadata keys, the
 * provenance shape, the history event's kind/actor, and follow-up quieting.
 *
 * TWO things deliberately stay with the caller:
 *
 *   1. The coarse `status` write. The member route accepts `won_on_escalation`,
 *      which {@link mapOutcomeToStatus} never returns — deriving status here
 *      would silently downgrade it to `won` and lose the D5 recoding signal.
 *      Each caller writes its own status through `updateDisputeOutcome` (which
 *      is also what runs the resolved sweep: follow-up cancellation, Pattern 1
 *      #13 outlier evaluation, accuracy scoring) and passes it in.
 *   2. Flushing the history event. The member route batches it with its own
 *      (letter_unsent / outcome_undone / letter_sent) in ONE round-trip, so
 *      this module RETURNS the event instead of emitting it. Emit it; never
 *      rebuild it by hand.
 *
 * Scope note: every write here is `userScoped` to the MEMBER who owns the
 * dispute. An operator's authority to reach the row is established upstream by
 * `operatorScoped` (role → grant → status → holder → claim-narrowed); this
 * module never widens it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { userScoped } from "@/lib/security/user-scoped";
import type { DisputeStatus } from "./persist";
import type { OutcomeDetail } from "./outcome-taxonomy";
import type { CaseEventInput } from "@/lib/case/case-events";

/**
 * WHO logged the outcome. Persisted verbatim to `metadata.outcomeReportedBy`
 * so the flywheel can separate evidence classes: a trained operator reading the
 * plan's own letter is not the same signal as a member self-report, and the two
 * must stay distinguishable in aggregate without re-deriving it from events.
 */
export type OutcomeReporter =
  | { actor: "user" }
  | { actor: "operator"; engagementId: string; operatorUserId: string };

/**
 * The metadata keys this module owns. The undo path deletes exactly these — kept
 * as one list so a key cannot be added here and forgotten there, which would
 * strand provenance on a row whose outcome was undone (and then misattribute
 * the next report).
 */
export const OUTCOME_METADATA_KEYS = [
  "outcomeDetail",
  "outcomeReportedAt",
  "outcomeReportedBy",
] as const;

export interface CommitOutcomeInput {
  disputeId: string;
  /** Null only for legacy rows with no claim — the history event is then skipped. */
  claimId: string | null;
  /** The MEMBER who owns the dispute (users PK, never firebase_uid). */
  userId: string;
  outcomeDetail: OutcomeDetail;
  /**
   * The coarse status the caller already wrote. Kept as an input rather than
   * derived — see the module contract (`won_on_escalation`).
   */
  status: DisputeStatus;
  /** The row's CURRENT metadata — merged, never clobbered (sibling keys survive). */
  existingMetadata: Record<string, unknown> | null;
  reportedBy: OutcomeReporter;
  /** Injectable clock for fixtures. */
  now?: Date;
}

/**
 * Record the fine-grained outcome: the metadata trio, then follow-up quieting.
 *
 * Both steps are fail-soft — the caller's status write already succeeded and is
 * the source of truth, so an outcome that landed is never lost to a secondary
 * write. This matches the member route's prior behaviour exactly.
 *
 * @returns the history event to emit (null when the row has no claim).
 */
export async function commitDisputeOutcome(
  supabase: SupabaseClient,
  input: CommitOutcomeInput,
): Promise<CaseEventInput | null> {
  // The fine-grained outcome + provenance (JSONB, Rule #9 store-first — no
  // schema change). Merge, never clobber.
  try {
    await userScoped(supabase, input.userId)
      .table("dispute_outcomes")
      .update({
        metadata: {
          ...(input.existingMetadata ?? {}),
          outcomeDetail: input.outcomeDetail,
          outcomeReportedAt: (input.now ?? new Date()).toISOString(),
          outcomeReportedBy: input.reportedBy,
        },
      })
      .eq("id", input.disputeId);
  } catch (err) {
    console.error("[commit-outcome] metadata persist failed (non-fatal):", err);
  }

  // Re-anchor or cancel the nudge chain. Fail-soft inside.
  const { quietOutcomeFollowups } = await import("./followups");
  await quietOutcomeFollowups(supabase, {
    disputeId: input.disputeId,
    userId: input.userId,
    outcomeDetail: input.outcomeDetail,
  });

  return outcomeCaseEvent(input);
}

/**
 * The history event for a committed outcome — PURE, so the fixtures can assert
 * the kind, the actor and the payload without a database.
 *
 * `collections` carries its own kind: the union holds it for exhaustiveness and
 * the honest event for it is the collections one, not a response.
 */
export function outcomeCaseEvent(
  input: Pick<
    CommitOutcomeInput,
    "claimId" | "disputeId" | "outcomeDetail" | "status" | "reportedBy"
  >,
): CaseEventInput | null {
  if (!input.claimId) return null;
  return {
    claimId: input.claimId,
    disputeId: input.disputeId,
    kind: input.outcomeDetail === "collections" ? "collections_reported" : "response_logged",
    actor: input.reportedBy.actor === "operator" ? "operator" : "user",
    payload: {
      outcomeDetail: input.outcomeDetail,
      status: input.status,
      ...(input.reportedBy.actor === "operator"
        ? { engagementId: input.reportedBy.engagementId }
        : {}),
    },
  };
}
