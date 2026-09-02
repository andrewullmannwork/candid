/**
 * GET /api/admin/dfy/engagements/[engagementId] — the matter view's data (S330).
 *
 * Any operator may VIEW a matter (the queue shows who holds it); acting
 * requires the holder — `canAct` says so and the action routes enforce it.
 * The timeline payload is the SAME projection the member's claim page renders
 * (loadCaseTimelinePayload) — Screen B is the member's own rail.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireOperator } from "@/lib/admin/require-operator";
import { operatorScoped } from "@/lib/security/operator-scoped";
import { loadCaseTimelinePayload } from "@/lib/case/load-case-timeline";
import { loadMatterSummary } from "@/lib/dfy/matter";
import { ENGAGEMENT_STATUSES } from "@/lib/dfy/engagement-state";
import { operatorErrorResponse } from "@/lib/dfy/operator-action";
import { packetForumsFor } from "@/lib/dfy/packet";

export async function GET(req: NextRequest, { params }: { params: Promise<{ engagementId: string }> }) {
  const auth = await requireOperator(req);
  if (!auth.ok) return auth.response;
  const { supabase, operatorUserId, config } = auth;
  const { engagementId } = await params;
  try {
    const scope = await operatorScoped(supabase, operatorUserId, engagementId, {
      statuses: ENGAGEMENT_STATUSES,
      requireHolder: false,
    });
    const e = scope.engagement;
    const [matter, timeline, insurer] = await Promise.all([
      loadMatterSummary(supabase, e),
      loadCaseTimelinePayload(supabase, e.user_id, e.claim_id),
      (async () => {
        const { data: c } = await scope.table("claims").select("insurance_plan_id").maybeSingle();
        const planId = (c as { insurance_plan_id?: string | null } | null)?.insurance_plan_id ?? null;
        if (!planId) return null;
        const { data: plan } = await scope.table("insurance_plans").select("insurer_id, insurer_name").eq("id", planId).maybeSingle();
        const p = plan as { insurer_id?: string | null; insurer_name?: string | null } | null;
        return p?.insurer_id ? { id: p.insurer_id, name: p.insurer_name ?? "the insurer" } : null;
      })(),
    ]);
    return NextResponse.json({
      matter,
      timeline,
      forums: packetForumsFor(e).map((f) => ({ id: f.id, short: f.short, menuLabel: f.menuLabel, role: f.role })),
      insurer,
      canAct: e.status === "active" && e.operator_user_id === operatorUserId,
      isHolder: e.operator_user_id === operatorUserId,
      config: { refusalRunwayBusinessDays: config.refusalRunwayBusinessDays },
    });
  } catch (err) {
    const { status, body } = operatorErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
