/**
 * POST /api/admin/dfy/engagements/[engagementId]/refund — refund a paid matter
 * (S330). Body: { basis: "converted_before_transmit" | "declined_at_intake" | "operator_discretion" }.
 * The holder (or any operator when the matter is closed and unclaimed) refunds
 * through Stripe on the payment fact the webhook wrote; the refund is recorded
 * on the same fact and audit-logged. Never twice.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireOperator } from "@/lib/admin/require-operator";
import { logAdminAction } from "@/lib/admin/audit-log";
import { operatorScoped, patchEngagement } from "@/lib/security/operator-scoped";
import { ENGAGEMENT_STATUSES } from "@/lib/dfy/engagement-state";
import { paymentFactOf, refundable, type RefundBasis } from "@/lib/dfy/fees";
import { emitOperatorEvent, operatorErrorResponse } from "@/lib/dfy/operator-action";
import { getStripe } from "@/lib/stripe";

const BASES = new Set<RefundBasis>(["converted_before_transmit", "declined_at_intake", "operator_discretion"]);

export async function POST(req: NextRequest, { params }: { params: Promise<{ engagementId: string }> }) {
  const auth = await requireOperator(req);
  if (!auth.ok) return auth.response;
  const { supabase, operatorUserId, operatorEmail, role, ip } = auth;
  const { engagementId } = await params;
  let body: { basis?: unknown };
  try { body = (await req.json()) as { basis?: unknown }; } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const basis = body.basis as RefundBasis;
  if (!BASES.has(basis)) return NextResponse.json({ error: "basis must name a refund path from the fee agreement", code: "bad_basis" }, { status: 400 });
  try {
    const probe = await operatorScoped(supabase, operatorUserId, engagementId, { statuses: ENGAGEMENT_STATUSES, requireHolder: false });
    const scope = probe.engagement.operator_user_id ? await operatorScoped(supabase, operatorUserId, engagementId, { statuses: ENGAGEMENT_STATUSES }) : probe;
    const e = scope.engagement;
    const payment = paymentFactOf(e.metadata);
    if (!refundable(payment)) return NextResponse.json({ error: "Nothing refundable on this matter", code: "not_refundable" }, { status: 409 });
    const now = new Date().toISOString();
    const refund = await getStripe().refunds.create({ payment_intent: payment!.intentId!, metadata: { dfy_engagement_id: e.id, basis } });
    const updated = await patchEngagement(supabase, e.id, { status: e.status }, {
      metadata: { ...e.metadata, payment: { ...payment, refund: { id: refund.id, amountCents: refund.amount, at: now, basis, by: operatorUserId } } },
    });
    if (!updated) return NextResponse.json({ error: "The matter changed — reload", code: "refund_race" }, { status: 409 });
    await emitOperatorEvent(supabase, { ...scope, engagement: updated }, "dfy_fee_refunded", { basis, refundRef: refund.id });
    await logAdminAction({ adminUserId: operatorUserId, adminEmail: operatorEmail, action: "dfy_refund", targetUserId: e.user_id, targetTable: "dfy_engagements", details: `engagement ${e.id}: refund ${refund.id} (${basis}) (${role})`, ipAddress: ip });
    return NextResponse.json({ ok: true, refundId: refund.id, amountCents: refund.amount });
  } catch (err) {
    const { status, body: b } = operatorErrorResponse(err);
    return NextResponse.json(b, { status });
  }
}
