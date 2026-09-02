/**
 * POST /api/dfy/engagements/[engagementId]/pay — the one-time matter fee (S330,
 * the PR-DFY-3 seam). Live only when `fee_cents` > 0 (the free pilot runs at 0).
 *
 * Reuses the platform's Stripe customer (stripe_customers) and creates a
 * PaymentIntent carrying the engagement id; the webhook's
 * payment_intent.succeeded branch records the payment on the engagement and
 * activates it. Per-matter, post-denial, never a subscription (Gate 5) — the
 * fee agreement the member just signed says exactly this.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/security/require-authenticated-user";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";
import { parseEngagementRow, DFY_ENGAGEMENT_COLUMNS } from "@/lib/security/operator-scoped";
import { readDfyState } from "@/lib/dfy/config";
import { getStripe } from "@/lib/stripe";

export async function POST(req: NextRequest, { params }: { params: Promise<{ engagementId: string }> }) {
  const user = await requireAuthenticatedUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.isAnonymous) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const supabase = createServerClient();
  const state = await readDfyState(supabase);
  if (!state.enabled) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { engagementId } = await params;

  const { data } = await userScoped(supabase, user.id)
    .table("dfy_engagements")
    .select(DFY_ENGAGEMENT_COLUMNS)
    .eq("id", engagementId)
    .maybeSingle();
  const e = parseEngagementRow(data);
  if (!e) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (e.status !== "signed" || e.payer !== "member_paid") {
    return NextResponse.json({ error: "This matter has no fee step right now", code: "no_fee_step" }, { status: 409 });
  }
  if (state.config.feeCents <= 0) {
    return NextResponse.json({ error: "No fee is due during the pilot", code: "fee_waived" }, { status: 409 });
  }
  if ((e.metadata as { payment?: { status?: string } }).payment?.status === "succeeded") {
    return NextResponse.json({ error: "Already paid", code: "already_paid" }, { status: 409 });
  }

  const stripe = getStripe();
  const { data: existingCustomer } = await userScoped(supabase, user.id)
    .table("stripe_customers")
    .select("stripe_customer_id")
    .maybeSingle();
  let customerId = (existingCustomer as { stripe_customer_id?: string } | null)?.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: user.email, metadata: { userId: user.id } });
    customerId = customer.id;
    await userScoped(supabase, user.id).table("stripe_customers").insert({
      stripe_customer_id: customerId,
      subscription_status: "none",
      subscription_tier: "free",
    });
  }
  const intent = await stripe.paymentIntents.create({
    amount: state.config.feeCents,
    currency: "usd",
    customer: customerId,
    description: `Candid — done-for-you appeal execution, matter ${e.id.slice(0, 8)}`,
    metadata: { dfy_engagement_id: e.id, userId: user.id },
    automatic_payment_methods: { enabled: true },
  });
  if (!intent.client_secret) return NextResponse.json({ error: "Missing client secret" }, { status: 500 });
  return NextResponse.json({ clientSecret: intent.client_secret, amountCents: state.config.feeCents });
}
