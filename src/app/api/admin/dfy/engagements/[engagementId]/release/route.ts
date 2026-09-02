/**
 * POST /api/admin/dfy/engagements/[engagementId]/release — hand a held matter back
 * to the unclaimed pool (S330). Only the holder may release; the release is a
 * logged event on the member's timeline like the claim was.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireOperator } from "@/lib/admin/require-operator";
import { logAdminAction } from "@/lib/admin/audit-log";
import { operatorScoped, releaseEngagement } from "@/lib/security/operator-scoped";
import { emitOperatorEvent, operatorErrorResponse } from "@/lib/dfy/operator-action";

const LIVE = ["eligibility_pending", "signed", "active"] as const;

export async function POST(req: NextRequest, { params }: { params: Promise<{ engagementId: string }> }) {
  const auth = await requireOperator(req);
  if (!auth.ok) return auth.response;
  const { supabase, operatorUserId, operatorEmail, role, ip } = auth;
  const { engagementId } = await params;
  try {
    const scope = await operatorScoped(supabase, operatorUserId, engagementId, { statuses: LIVE });
    const updated = await releaseEngagement(supabase, operatorUserId, engagementId);
    if (!updated) {
      return NextResponse.json({ error: "Release did not land", code: "release_race" }, { status: 409 });
    }
    await emitOperatorEvent(supabase, scope, "dfy_released");
    await logAdminAction({
      adminUserId: operatorUserId,
      adminEmail: operatorEmail,
      action: "dfy_release",
      targetUserId: updated.user_id,
      targetTable: "dfy_engagements",
      details: `engagement ${updated.id} released (${role})`,
      ipAddress: ip,
    });
    return NextResponse.json({ ok: true, engagement: updated });
  } catch (err) {
    const { status, body } = operatorErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
