/**
 * POST /api/admin/dfy/engagements/[engagementId]/transition — lifecycle moves an
 * operator may make (S330). Body: { to: "active" | "completed" | "terminated" | "converted", reason?: string }
 *
 *   signed → active      activation. Requires the holder, the member's
 *                        composition proof, and the payer rule: sponsor_paid
 *                        needs a sponsor reference; member_paid activates with
 *                        the fee WAIVED while the free pilot runs (recorded in
 *                        scope.feeWaived — the $5 charge is PR-DFY-3 and flips
 *                        on counsel's opinion signature, S326 ruling).
 *   active → completed | terminated | converted   the holder closes the matter.
 *   eligibility_pending | signed → terminated     decline / withdrawal — any
 *                        operator when unclaimed, else the holder.
 *
 * `signed` itself is the MEMBER's act (the paper stack, PR-DFY-2) — never set here.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireOperator } from "@/lib/admin/require-operator";
import { logAdminAction } from "@/lib/admin/audit-log";
import { operatorScoped, patchEngagement } from "@/lib/security/operator-scoped";
import { assertTransition, EngagementTransitionError, type EngagementStatus } from "@/lib/dfy/engagement-state";
import { compositionComplete, emitOperatorEvent, loadCompositionProof, operatorErrorResponse } from "@/lib/dfy/operator-action";

const OPERATOR_TARGETS = new Set<EngagementStatus>(["active", "completed", "terminated", "converted"]);
const ALL = ["eligibility_pending", "signed", "active", "converted", "terminated", "completed"] as const;

export async function POST(req: NextRequest, { params }: { params: Promise<{ engagementId: string }> }) {
  const auth = await requireOperator(req);
  if (!auth.ok) return auth.response;
  const { supabase, operatorUserId, operatorEmail, role, ip } = auth;
  const { engagementId } = await params;

  let body: { to?: unknown; reason?: unknown };
  try {
    body = (await req.json()) as { to?: unknown; reason?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const to = body.to as EngagementStatus;
  if (!OPERATOR_TARGETS.has(to)) {
    return NextResponse.json({ error: "to must be active | completed | terminated | converted", code: "bad_target" }, { status: 400 });
  }
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 200) : null;

  try {
    // Holder required whenever a holder exists; an unclaimed applicant may be declined by any operator.
    const probe = await operatorScoped(supabase, operatorUserId, engagementId, { statuses: ALL, requireHolder: false });
    const requireHolder = probe.engagement.operator_user_id !== null || to === "active";
    const scope = requireHolder
      ? await operatorScoped(supabase, operatorUserId, engagementId, { statuses: ALL })
      : probe;
    const e = scope.engagement;
    assertTransition(e.status, to);

    const now = new Date().toISOString();
    const patch: Parameters<typeof patchEngagement>[3] = { status: to };
    if (to === "active") {
      const proof = await loadCompositionProof(supabase, e.user_id, e.claim_id);
      if (!compositionComplete(proof)) {
        return NextResponse.json(
          { error: "The member has not composed the appeal themselves yet", code: "composition_missing" },
          { status: 409 },
        );
      }
      if (e.payer === "sponsor_paid" && !e.sponsor_ref) {
        return NextResponse.json({ error: "A sponsor reference is required for a sponsor-paid matter", code: "sponsor_ref_missing" }, { status: 409 });
      }
      patch.activated_at = now;
      patch.scope = {
        ...e.scope,
        lane: "insurer",
        memberFilesAtStateLevel: true,
        feeWaived: e.payer === "member_paid" ? "free_pilot" : null,
        activatedBy: { operatorUserId, role },
      };
    } else {
      patch.closed_at = now;
      patch.metadata = { ...e.metadata, closedReason: reason, closedBy: { operatorUserId, role } };
    }
    const updated = await patchEngagement(supabase, engagementId, { status: e.status }, patch);
    if (!updated) {
      return NextResponse.json({ error: "The matter changed underneath you — reload", code: "transition_race" }, { status: 409 });
    }
    await emitOperatorEvent(
      supabase,
      { ...scope, engagement: updated },
      to === "active" ? "dfy_engagement_activated" : "dfy_engagement_closed",
      { status: to },
    );
    await logAdminAction({
      adminUserId: operatorUserId,
      adminEmail: operatorEmail,
      action: `dfy_transition:${to}`,
      targetUserId: updated.user_id,
      targetTable: "dfy_engagements",
      details: `engagement ${updated.id}: ${e.status} → ${to}${reason ? ` (${reason})` : ""} (${role})`,
      ipAddress: ip,
    });
    return NextResponse.json({ ok: true, engagement: updated });
  } catch (err) {
    if (err instanceof EngagementTransitionError) {
      return NextResponse.json({ error: err.message, code: "bad_transition" }, { status: 409 });
    }
    const { status, body: b } = operatorErrorResponse(err);
    return NextResponse.json(b, { status });
  }
}
