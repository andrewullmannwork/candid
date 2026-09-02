/**
 * POST /api/dfy/engagements/[engagementId]/cancel — the MEMBER ends their own
 * engagement (S330). Body: { reason?: string }.
 *
 * Any live status may be ended by the member ("Either party may end this
 * engagement at any time" — scope §7). Within three business days of signing a
 * paid fee is refunded in full (fee agreement §5) through Stripe, on the same
 * payment fact the webhook wrote. The termination is a spine event with
 * actor 'user'; the holder is notified by the queue, not by email — the matter
 * simply leaves their load.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/security/require-authenticated-user";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";
import { parseEngagementRow, patchEngagement, DFY_ENGAGEMENT_COLUMNS } from "@/lib/security/operator-scoped";
import { readDfyState } from "@/lib/dfy/config";
import { assertTransition } from "@/lib/dfy/engagement-state";
import { paymentFactOf, refundable, withinCancelWindow } from "@/lib/dfy/fees";
import { emitCaseEvents } from "@/lib/case/case-events";
import { getStripe } from "@/lib/stripe";

export async function POST(req: NextRequest, { params }: { params: Promise<{ engagementId: string }> }) {
  const user = await requireAuthenticatedUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const supabase = createServerClient();
  const state = await readDfyState(supabase);
  if (!state.enabled) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { engagementId } = await params;
  let body: { reason?: unknown } = {};
  try { body = (await req.json()) as { reason?: unknown }; } catch { /* optional */ }
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 200) : null;

  const { data } = await userScoped(supabase, user.id).table("dfy_engagements").select(DFY_ENGAGEMENT_COLUMNS).eq("id", engagementId).maybeSingle();
  const e = parseEngagementRow(data);
  if (!e) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!["eligibility_pending", "signed", "active"].includes(e.status)) {
    return NextResponse.json({ error: "This engagement is already closed.", code: "not_live" }, { status: 409 });
  }
  assertTransition(e.status, "terminated");
  const now = new Date();

  // Refund inside the window, on the fact the webhook wrote.
  const payment = paymentFactOf(e.metadata);
  let refundNote: Record<string, unknown> = {};
  if (refundable(payment) && withinCancelWindow(e.signed_at, now)) {
    try {
      const refund = await getStripe().refunds.create({ payment_intent: payment!.intentId!, metadata: { dfy_engagement_id: e.id, basis: "member_cancel_window" } });
      refundNote = { payment: { ...payment, refund: { id: refund.id, amountCents: refund.amount, at: now.toISOString(), basis: "member_cancel_window", by: null } } };
    } catch (err) {
      console.error("[dfy cancel] refund failed (termination proceeds; operator refund path remains):", err);
      refundNote = { refundFailed: { at: now.toISOString(), basis: "member_cancel_window" } };
    }
  }

  const updated = await patchEngagement(supabase, e.id, { status: e.status }, {
    status: "terminated",
    closed_at: now.toISOString(),
    metadata: { ...e.metadata, ...refundNote, closedReason: reason ? `member cancelled — ${reason}` : "member cancelled", closedBy: { actor: "user", userId: user.id } },
  });
  if (!updated) return NextResponse.json({ error: "This page changed. Reload and try again.", code: "cancel_race" }, { status: 409 });
  await emitCaseEvents(supabase, user.id, [
    { claimId: e.claim_id, kind: "dfy_engagement_closed", actor: "user", payload: { engagementId: e.id, status: "terminated", by: "member", ...(refundNote.payment ? { refunded: true } : {}) } },
  ]);
  return NextResponse.json({ ok: true, status: "terminated", refunded: !!refundNote.payment });
}
