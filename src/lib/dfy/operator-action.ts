/**
 * operator-action — the ROUTE-LAYER invariant for every operator act (handoff §3).
 *
 * Before an operator action route accepts anything, THREE things must hold,
 * all fail-closed:
 *   1. the engagement is ACTIVE and the caller HOLDS it (operatorScoped);
 *   2. the member's OWN composition events exist on the claim — the
 *      `ground_selected` + `letter_adopted` record the free tool writes when
 *      the member selects grounds and adopts the letter. This is the
 *      composition-precedes-execution proof: Candid transmits what the member
 *      composed, never what software chose. It lives HERE, not in a spine
 *      trigger, because the spine's emitters are fail-soft by design and a hard
 *      gate belongs where the other gates live (the route layer);
 *   3. the act is one of the enumerated operator kinds.
 *
 * Every accepted act writes a tagged `actor: 'operator'` event onto the SAME
 * timeline the member sees, references only.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { userScoped } from "@/lib/security/user-scoped";
import {
  operatorScoped,
  OperatorAccessError,
  type OperatorScope,
  type OperatorScopeOptions,
} from "@/lib/security/operator-scoped";
import { emitCaseEvents, type CaseEventKind } from "@/lib/case/case-events";

export interface CompositionProof {
  groundSelected: boolean;
  letterAdopted: boolean;
}

/** The member's own composition record on the claim. Read via the MEMBER's ownership (userScoped). */
export async function loadCompositionProof(
  supabase: SupabaseClient,
  memberUserId: string,
  claimId: string,
): Promise<CompositionProof> {
  const { data, error } = await userScoped(supabase, memberUserId)
    .table("claim_case_events")
    .select("kind")
    .eq("claim_id", claimId)
    .in("kind", ["ground_selected", "letter_adopted"]);
  if (error) {
    // Fail closed: an unreadable record is not a record.
    console.error("[dfy] composition proof read failed:", error);
    return { groundSelected: false, letterAdopted: false };
  }
  const kinds = new Set(((data ?? []) as Array<{ kind?: string }>).map((r) => r.kind));
  return {
    groundSelected: kinds.has("ground_selected"),
    letterAdopted: kinds.has("letter_adopted"),
  };
}

export function compositionComplete(p: CompositionProof): boolean {
  return p.groundSelected && p.letterAdopted;
}

/** The operator acts — each one a spine kind, each rendered "Done by Candid · date". */
export const OPERATOR_ACT_KINDS = [
  "dfy_designation_submitted",
  "dfy_designation_acknowledged",
  "dfy_document_requested",
  "dfy_appeal_transmitted",
  "dfy_status_called",
  "dfy_response_recorded",
  "dfy_offer_relayed",
  "dfy_packet_prepared",
  "dfy_determination_recorded",
  "dfy_audit_logged",
] as const satisfies readonly CaseEventKind[];

export type OperatorActKind = (typeof OPERATOR_ACT_KINDS)[number];

export function isOperatorActKind(value: unknown): value is OperatorActKind {
  return typeof value === "string" && (OPERATOR_ACT_KINDS as readonly string[]).includes(value);
}

/**
 * Acts that EXECUTE the member's composition (transmit / submit) require the
 * composition proof. Recording what the plan said back, logging a status call,
 * or logging the audit review do not — they are facts about the world, and a
 * matter that is active is already past the gate. The proof is still asserted
 * for those at activation (the engagement cannot become active without it).
 */
export const COMPOSITION_GATED_ACTS: ReadonlySet<OperatorActKind> = new Set<OperatorActKind>([
  "dfy_designation_submitted",
  "dfy_document_requested",
  "dfy_appeal_transmitted",
  "dfy_packet_prepared",
]);

/**
 * Resolve the operator's scope for an act, asserting every invariant. Throws
 * OperatorAccessError (401/403/404/409) — routes map `.status` to the response.
 */
export async function assertOperatorAction(
  supabase: SupabaseClient,
  callerUserId: string,
  engagementId: string,
  kind: OperatorActKind,
  opts: OperatorScopeOptions = {},
): Promise<OperatorScope> {
  const scope = await operatorScoped(supabase, callerUserId, engagementId, opts);
  if (COMPOSITION_GATED_ACTS.has(kind)) {
    const proof = await loadCompositionProof(supabase, scope.engagement.user_id, scope.engagement.claim_id);
    if (!compositionComplete(proof)) {
      throw new OperatorAccessError(
        409,
        "composition_missing",
        "the member has not composed this appeal themselves (no ground_selected + letter_adopted on the claim)",
      );
    }
  }
  return scope;
}

/**
 * Emit an operator act onto the member's timeline. Fail-soft like every
 * emitter (a lost history line never blocks the member); references only.
 */
export async function emitOperatorEvent(
  supabase: SupabaseClient,
  scope: OperatorScope,
  kind: CaseEventKind,
  payload: Record<string, unknown> = {},
  disputeId: string | null = null,
): Promise<void> {
  await emitCaseEvents(supabase, scope.engagement.user_id, [
    {
      claimId: scope.engagement.claim_id,
      disputeId,
      kind,
      actor: "operator",
      payload: {
        engagementId: scope.engagement.id,
        operatorUserId: scope.callerUserId,
        role: scope.role,
        ...payload,
      },
    },
  ]);
}

/** Map an OperatorAccessError to a JSON body + status for a route. */
export function operatorErrorResponse(err: unknown): { status: number; body: { error: string; code: string } } {
  if (err instanceof OperatorAccessError) {
    return { status: err.status, body: { error: err.message, code: err.code } };
  }
  return { status: 500, body: { error: "Unexpected error", code: "internal" } };
}
