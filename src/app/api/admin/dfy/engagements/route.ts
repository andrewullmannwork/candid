/**
 * POST /api/admin/dfy/engagements — open an engagement for an INVITED member (S330).
 *
 * The pilot is invitation-only: an operator opens the grant row for a member's
 * claim; the member then signs the paper stack (PR-DFY-2) and screening runs
 * (this PR). Body: { memberEmail | memberUserId, claimId, payer?, sponsorRef? }.
 *
 * Ownership is verified BEFORE the row exists: the claim must be the member's
 * own (read through the member's ownership); the plan classification and
 * state are SNAPSHOTTED onto the engagement so the record shows what intake saw.
 * One live engagement per claim (partial unique index → 409).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireOperator } from "@/lib/admin/require-operator";
import { logAdminAction } from "@/lib/admin/audit-log";
import { userScoped } from "@/lib/security/user-scoped";
import { createEngagement, type EngagementPayer } from "@/lib/security/operator-scoped";
import { emitCaseEvents } from "@/lib/case/case-events";
import { operatorErrorResponse } from "@/lib/dfy/operator-action";

export async function POST(req: NextRequest) {
  const auth = await requireOperator(req);
  if (!auth.ok) return auth.response;
  const { supabase, operatorUserId, operatorEmail, role, ip } = auth;

  let body: { memberEmail?: unknown; memberUserId?: unknown; claimId?: unknown; payer?: unknown; sponsorRef?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const claimId = typeof body.claimId === "string" ? body.claimId.trim() : "";
  if (!claimId) return NextResponse.json({ error: "claimId required" }, { status: 400 });
  const payer: EngagementPayer = body.payer === "sponsor_paid" ? "sponsor_paid" : "member_paid";
  const sponsorRef = typeof body.sponsorRef === "string" && body.sponsorRef.trim() ? body.sponsorRef.trim().slice(0, 80) : null;
  if (payer === "sponsor_paid" && !sponsorRef) {
    return NextResponse.json({ error: "A sponsor reference is required for a sponsor-paid matter", code: "sponsor_ref_missing" }, { status: 400 });
  }

  try {
    // Resolve the member (users is not a user-owned-registered table).
    let memberQ = supabase.from("users").select("id, email, is_anonymous");
    if (typeof body.memberUserId === "string" && body.memberUserId) memberQ = memberQ.eq("id", body.memberUserId);
    else if (typeof body.memberEmail === "string" && body.memberEmail.trim()) memberQ = memberQ.eq("email", body.memberEmail.trim().toLowerCase());
    else return NextResponse.json({ error: "memberEmail or memberUserId required" }, { status: 400 });
    const { data: member } = await memberQ.maybeSingle();
    const m = member as { id: string; email: string; is_anonymous?: boolean } | null;
    if (!m) return NextResponse.json({ error: "Member not found" }, { status: 404 });
    if (m.is_anonymous) return NextResponse.json({ error: "An anonymous account cannot enter an engagement", code: "anonymous_member" }, { status: 409 });

    // The claim must be the member's own.
    const { data: claim } = await userScoped(supabase, m.id)
      .table("claims")
      .select("id, insurance_plan_id")
      .eq("id", claimId)
      .maybeSingle();
    const c = claim as { id: string; insurance_plan_id: string | null } | null;
    if (!c) return NextResponse.json({ error: "Claim not found for this member" }, { status: 404 });

    const [profile, plan] = await Promise.all([
      userScoped(supabase, m.id).table("profiles").select("state").maybeSingle(),
      c.insurance_plan_id
        ? userScoped(supabase, m.id).table("insurance_plans").select("metadata").eq("id", c.insurance_plan_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    const planMeta = ((plan as { data?: { metadata?: Record<string, unknown> } | null }).data?.metadata ?? null) as Record<string, unknown> | null;
    const classification = planMeta && typeof planMeta.regulatory_classification === "object" && planMeta.regulatory_classification
      ? (planMeta.regulatory_classification as Record<string, unknown>)
      : null;

    const { engagement, conflict } = await createEngagement(supabase, m.id, {
      claim_id: c.id,
      payer,
      sponsor_ref: sponsorRef,
      member_state: ((profile.data as { state?: string | null } | null)?.state ?? null),
      plan_classification: classification,
      metadata: { invitedBy: { operatorUserId, role }, invitedAt: new Date().toISOString() },
    });
    if (conflict) return NextResponse.json({ error: "This claim already has a live engagement", code: "engagement_exists" }, { status: 409 });
    if (!engagement) return NextResponse.json({ error: "Could not open the engagement", code: "create_failed" }, { status: 500 });

    await emitCaseEvents(supabase, m.id, [
      {
        claimId: c.id,
        kind: "dfy_engagement_created",
        actor: "operator",
        payload: { engagementId: engagement.id, operatorUserId, role, payer },
      },
    ]);
    await logAdminAction({
      adminUserId: operatorUserId,
      adminEmail: operatorEmail,
      action: "dfy_engagement_create",
      targetUserId: m.id,
      targetTable: "dfy_engagements",
      details: `engagement ${engagement.id} opened on claim ${c.id} (${payer}${sponsorRef ? `, sponsor ${sponsorRef}` : ""}) (${role})`,
      ipAddress: ip,
    });
    return NextResponse.json({ ok: true, engagement }, { status: 201 });
  } catch (err) {
    const { status, body: b } = operatorErrorResponse(err);
    return NextResponse.json(b, { status });
  }
}
