/**
 * POST /api/admin/dfy/engagements/[engagementId]/actions/undo — take back a
 * mis-clicked operator act (S331).
 *
 * Body: { eventId }  — the exact act being corrected.
 *
 * Compensation, never deletion: the act's event stays, and a `dfy_act_undone`
 * event is appended referring to it (see `act-undo` for why). Whatever the act
 * wrote BEYOND its event is reversed here, per footprint — an undo that left
 * those standing would be a lie in the shape of a fix.
 *
 * The determination's reversal deliberately goes through the member's OWN undo
 * semantics — clear the outcome trio, restore the status the act recorded it
 * moved from — so there is still exactly one description of what an undone
 * outcome looks like.
 *
 * Authority: `requireOperator` + `operatorScoped`, the same gate as the acts
 * themselves; only the HOLDER may undo, and only on their own matter.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireOperator } from "@/lib/admin/require-operator";
import { operatorScoped } from "@/lib/security/operator-scoped";
import { operatorErrorResponse } from "@/lib/dfy/operator-action";
import { emitCaseEvents } from "@/lib/case/case-events";
import { logAdminAction } from "@/lib/admin/audit-log";
import {
  ACT_UNDO,
  ACT_UNDONE_KIND,
  isUndoableAct,
  undoneEventIds,
  UNDO_COPY,
} from "@/lib/dfy/act-undo";
import { OUTCOME_METADATA_KEYS } from "@/lib/disputes/commit-outcome";
import { updateDisputeOutcome, type DisputeStatus } from "@/lib/disputes/persist";
import { userScoped } from "@/lib/security/user-scoped";

export async function POST(req: NextRequest, { params }: { params: Promise<{ engagementId: string }> }) {
  const { engagementId } = await params;
  const auth = await requireOperator(req);
  if (!auth.ok) return auth.response;
  const { supabase, operatorUserId, operatorEmail, role, ip } = auth;

  let body: { eventId?: unknown };
  try {
    body = (await req.json()) as { eventId?: unknown };
  } catch {
    return NextResponse.json({ error: "Bad request", code: "bad_body" }, { status: 400 });
  }
  const eventId = typeof body.eventId === "string" ? body.eventId.trim() : "";
  if (!eventId) return NextResponse.json({ error: "eventId required", code: "event_required" }, { status: 400 });

  try {
  // `operatorScoped` already enforces the holder rule (requireHolder defaults
  // true) and narrows every table to this engagement's claim — one gate, not a
  // second copy of it here.
  const scope = await operatorScoped(supabase, operatorUserId, engagementId);
  const engagement = scope.engagement;

  // The event must be an operator act ON THIS MATTER's claim. The scoped read
  // is the authority proof: the operator scope narrows claim_case_events by the
  // engagement's claim_id, so an event on any other claim is simply not here.
  const { data: rows } = await scope
    .table("claim_case_events")
    .select("id, kind, dispute_id, payload, occurred_at")
    .eq("claim_id", engagement.claim_id);
  const events = (rows ?? []) as Array<{
    id: string;
    kind: string;
    dispute_id: string | null;
    payload: Record<string, unknown> | null;
    occurred_at: string;
  }>;

  const target = events.find((e) => e.id === eventId);
  if (!target) {
    return NextResponse.json({ error: UNDO_COPY.notOnMatter, code: "not_on_matter" }, { status: 404 });
  }
  if (!isUndoableAct(target.kind)) {
    return NextResponse.json({ error: UNDO_COPY.notUndoable, code: "not_undoable" }, { status: 400 });
  }
  if (undoneEventIds(events).has(eventId)) {
    return NextResponse.json({ error: UNDO_COPY.alreadyUndone, code: "already_undone" }, { status: 409 });
  }

  const spec = ACT_UNDO[target.kind];
  const payload = target.payload ?? {};
  const disputeId = target.dispute_id;
  const reversed: Record<string, unknown> = {};

  // ── reverse whatever the act wrote beyond its event ──
  try {
    if (spec.footprint === "dispute_metadata" && disputeId) {
      const { data: row } = await scope.table("dispute_outcomes").select("metadata").eq("id", disputeId).maybeSingle();
      const meta = { ...(((row as { metadata?: Record<string, unknown> } | null)?.metadata ?? {}) as Record<string, unknown>) };
      delete meta.dfy_offer;
      await scope.table("dispute_outcomes").update({ metadata: meta }).eq("id", disputeId);
      reversed.offerCleared = true;
    }

    if (spec.footprint === "dispute_outcome" && disputeId) {
      // The member's own undo shape: drop the outcome trio, put the coarse
      // status back where the act found it. `statusFrom` is recorded by the act
      // (the `letter_sent` idiom); older acts without it fall back to the open
      // state, which is what an un-determined appeal is.
      const { data: row } = await scope.table("dispute_outcomes").select("metadata").eq("id", disputeId).maybeSingle();
      const meta = { ...(((row as { metadata?: Record<string, unknown> } | null)?.metadata ?? {}) as Record<string, unknown>) };
      for (const k of OUTCOME_METADATA_KEYS) delete meta[k];
      await scope.table("dispute_outcomes").update({ metadata: meta }).eq("id", disputeId);
      const back = (typeof payload.statusFrom === "string" ? payload.statusFrom : "in_progress") as DisputeStatus;
      await updateDisputeOutcome(supabase, disputeId, { status: back });
      reversed.outcomeCleared = true;
      reversed.statusRestored = back;
    }

    if (spec.footprint === "member_document" && typeof payload.documentId === "string") {
      // The member's own document — withdrawn, never deleted.
      const { data: doc } = await userScoped(supabase, engagement.user_id)
        .table("documents")
        .select("metadata")
        .eq("id", payload.documentId)
        .maybeSingle();
      const dmeta = ((doc as { metadata?: Record<string, unknown> } | null)?.metadata ?? {}) as Record<string, unknown>;
      await userScoped(supabase, engagement.user_id)
        .table("documents")
        .update({
          metadata: { ...dmeta, withdrawnAt: new Date().toISOString(), withdrawnBy: { actor: "operator", operatorUserId } },
        })
        .eq("id", payload.documentId);
      reversed.documentWithdrawn = payload.documentId;
    }

    if (spec.footprint === "insurer_proposal" && typeof payload.insurerId === "string") {
      // `superseded` is already this table's word for "no longer the proposal".
      const { error: supErr } = await supabase
        .from("insurer_appeals_proposed_changes")
        .update({ status: "superseded" })
        .eq("insurer_id", payload.insurerId)
        .eq("proposed_by_user_id", operatorUserId)
        .eq("status", "pending");
      if (supErr) console.error("[dfy undo] proposal supersede failed (non-fatal):", supErr);
      else reversed.proposalSuperseded = true;
    }
  } catch (err) {
    console.error("[dfy undo] reversal failed:", err);
    return NextResponse.json({ error: "Could not undo that step", code: "undo_failed" }, { status: 500 });
  }

  // ── the correction itself: appended, refs only ──
  await emitCaseEvents(supabase, engagement.user_id, [
    {
      claimId: engagement.claim_id,
      disputeId,
      kind: ACT_UNDONE_KIND,
      actor: "operator",
      payload: {
        undoneEventId: eventId,
        undoneKind: target.kind,
        engagementId: engagement.id,
        operatorUserId,
        ...reversed,
      },
    },
  ]);

  await logAdminAction({
    adminUserId: operatorUserId,
    adminEmail: operatorEmail,
    action: `dfy_undo:${target.kind}`,
    targetUserId: engagement.user_id,
    targetTable: "claim_case_events",
    details: `engagement ${engagement.id} undid event ${eventId} (${role})`,
    ipAddress: ip,
  });

  return NextResponse.json({ ok: true, undoneEventId: eventId, undoneKind: target.kind, reversed });
  } catch (err) {
    const { status, body: b } = operatorErrorResponse(err);
    return NextResponse.json(b, { status });
  }
}
