/**
 * POST /api/admin/dfy/engagements/[engagementId]/claim — the claim mechanic (S330).
 *
 * A matter must be claimed before anyone can act on it. Claiming stamps the
 * caller onto dfy_engagements.operator_user_id and logs a `dfy_claimed` event
 * on the member's timeline; the route layer then accepts actions on this
 * matter only from the holder. The concurrent cap is PER OPERATOR
 * (config `concurrent_cap`, counted over signed + active matters). Idempotent
 * for the holder; 409 when another operator holds it, when the cap is
 * reached, or when a concurrent claim won the race (zero-row update).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireOperator } from "@/lib/admin/require-operator";
import { logAdminAction } from "@/lib/admin/audit-log";
import { operatorScoped, claimEngagement, countHeldMatters } from "@/lib/security/operator-scoped";
import { emitOperatorEvent, operatorErrorResponse } from "@/lib/dfy/operator-action";
import { CAP_COUNTED_STATUSES } from "@/lib/dfy/engagement-state";
import { sendDfyInvitationEmail } from "@/lib/email/dfy-emails";
import { paperComplete } from "@/lib/dfy/paper";

const LIVE = ["eligibility_pending", "signed", "active"] as const;

export async function POST(req: NextRequest, { params }: { params: Promise<{ engagementId: string }> }) {
  const auth = await requireOperator(req);
  if (!auth.ok) return auth.response;
  const { supabase, operatorUserId, operatorEmail, role, config, ip } = auth;
  const { engagementId } = await params;
  try {
    const scope = await operatorScoped(supabase, operatorUserId, engagementId, {
      statuses: LIVE,
      requireHolder: false,
    });
    const e = scope.engagement;
    if (e.operator_user_id === operatorUserId) {
      return NextResponse.json({ ok: true, engagement: e, alreadyHeld: true });
    }
    if (e.operator_user_id) {
      return NextResponse.json({ error: "Another operator holds this matter", code: "held_by_other" }, { status: 409 });
    }
    if ((CAP_COUNTED_STATUSES as readonly string[]).includes(e.status)) {
      const held = await countHeldMatters(supabase, operatorUserId, CAP_COUNTED_STATUSES);
      if (held >= config.concurrentCap) {
        return NextResponse.json(
          { error: `Your load is ${held} of ${config.concurrentCap} — release a matter first`, code: "cap_reached" },
          { status: 409 },
        );
      }
    }
    const updated = await claimEngagement(supabase, operatorUserId, engagementId);
    if (!updated) {
      return NextResponse.json({ error: "Claim did not land — someone else claimed first", code: "claim_race" }, { status: 409 });
    }
    await emitOperatorEvent(supabase, { ...scope, engagement: updated }, "dfy_claimed");
    // A member who APPLIED (no inviter) and screened eligible can sign only once a
    // holder exists — the designation names that person. Point them to their page now.
    const decision = (updated.intake as { decision?: { eligible?: boolean } }).decision;
    if (updated.status === "eligibility_pending" && decision?.eligible !== false && !paperComplete(updated.payer, updated.consent_event_ids)) {
      const { data: m } = await supabase.from("users").select("email, display_name").eq("id", updated.user_id).maybeSingle();
      const mr = m as { email?: string; display_name?: string | null } | null;
      if (mr?.email) void sendDfyInvitationEmail({ to: mr.email, firstName: mr.display_name?.trim().split(/\s+/)[0] ?? null, engagementId: updated.id });
    }
    await logAdminAction({
      adminUserId: operatorUserId,
      adminEmail: operatorEmail,
      action: "dfy_claim",
      targetUserId: updated.user_id,
      targetTable: "dfy_engagements",
      details: `engagement ${updated.id} claimed (${role})`,
      ipAddress: ip,
    });
    return NextResponse.json({ ok: true, engagement: updated, alreadyHeld: false });
  } catch (err) {
    const { status, body } = operatorErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
