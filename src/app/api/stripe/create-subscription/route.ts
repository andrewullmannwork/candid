/**
 * POST /api/stripe/create-subscription — Create an incomplete Stripe subscription
 * for in-app Elements payment confirmation.
 *
 * Body: { triggerSurface: "dispute" | "case" | "care" }
 *   Stored in Stripe subscription metadata for downstream analytics ("which
 *   paywall converts best"); does not affect pricing.
 *
 * Auth: Firebase bearer token.
 *
 * Returns: { subscriptionId, clientSecret }
 *   clientSecret is for the first invoice's PaymentIntent — frontend passes
 *   it to <Elements> and calls stripe.confirmPayment().
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe";
import type Stripe from "stripe";

const TRIGGER_SURFACES = ["dispute", "case", "care"] as const;
type TriggerSurface = typeof TRIGGER_SURFACES[number];

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const priceId = process.env.STRIPE_PRO_PRICE_ID;
  if (!priceId) {
    return NextResponse.json({ error: "Stripe price not configured" }, { status: 500 });
  }

  const body = await req.json().catch(() => ({}));
  const triggerSurface: TriggerSurface = TRIGGER_SURFACES.includes(body.triggerSurface)
    ? body.triggerSurface
    : "dispute";

  const supabase = createServerClient();

  const { data: user } = await supabase
    .from("users")
    .select("id, email")
    .eq("firebase_uid", decoded.uid)
    .single();

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const { data: existingCustomer } = await supabase
    .from("stripe_customers")
    .select("stripe_customer_id, stripe_subscription_id, subscription_status")
    .eq("user_id", user.id)
    .maybeSingle();

  // Idempotency: if the user already has an active subscription, don't create
  // another one. Return a structured response so the frontend can skip the
  // modal entirely and refresh subscription state.
  if (
    existingCustomer?.subscription_status === "active" ||
    existingCustomer?.subscription_status === "trialing"
  ) {
    return NextResponse.json(
      { error: "already_subscribed" },
      { status: 409 }
    );
  }

  const stripe = getStripe();

  let customerId = existingCustomer?.stripe_customer_id;
  if (!customerId) {
    // Stripe idempotency key scoped to this user — if the client fires the
    // request twice (React Strict Mode in dev, fast double-clicks in prod),
    // Stripe returns the same customer instead of creating a duplicate.
    let customer: Stripe.Customer;
    try {
      customer = await stripe.customers.create(
        { email: user.email, metadata: { userId: user.id } },
        { idempotencyKey: `customer:${user.id}` }
      );
    } catch (err) {
      // Surface the real Stripe reason (bad live key, etc.) as JSON instead of
      // an unhandled 500 the client can't parse ("Unexpected end of JSON input").
      console.error("[create-subscription] stripe.customers.create failed:", err);
      return NextResponse.json(
        {
          error: err instanceof Error ? err.message : "Could not create Stripe customer",
          code: (err as { code?: string })?.code,
        },
        { status: 502 }
      );
    }
    customerId = customer.id;
    // Upsert on user_id so a racing concurrent INSERT can't create two rows.
    await supabase
      .from("stripe_customers")
      .upsert(
        {
          user_id: user.id,
          stripe_customer_id: customerId,
          subscription_status: "none",
          subscription_tier: "free",
        },
        { onConflict: "user_id" }
      );
  }

  // Reuse an existing incomplete subscription instead of creating another
  // one. This catches any double-fire that slips past the client-side ref
  // guard — if we already have an incomplete sub for this user, return its
  // client_secret. The client will confirm the same PaymentIntent it would
  // have the first time.
  if (existingCustomer?.stripe_subscription_id) {
    try {
      const existing = await stripe.subscriptions.retrieve(
        existingCustomer.stripe_subscription_id,
        { expand: ["latest_invoice.confirmation_secret", "latest_invoice.payment_intent"] }
      );
      if (existing.status === "incomplete") {
        const invoice = existing.latest_invoice as
          | (Stripe.Invoice & {
              confirmation_secret?: { client_secret: string | null; type: string } | null;
              payment_intent?: Stripe.PaymentIntent | null;
            })
          | null;
        const reuseSecret =
          invoice?.confirmation_secret?.client_secret ??
          invoice?.payment_intent?.client_secret ??
          null;
        if (reuseSecret) {
          return NextResponse.json({
            subscriptionId: existing.id,
            clientSecret: reuseSecret,
          });
        }
      }
    } catch (err) {
      // Subscription may have been deleted server-side; fall through to
      // create a new one.
      console.warn("[create-subscription] Could not reuse existing subscription:", err);
    }
  }

  // default_incomplete + save_default_payment_method=on_subscription lets us
  // collect the card inline via Elements. The subscription stays in
  // `incomplete` status until stripe.confirmPayment() succeeds, at which
  // point the webhook flips our tier to pro.
  //
  // Expand both `confirmation_secret` (new Clover-era shape) and
  // `payment_intent` (legacy shape) so we work across API versions.
  let subscription: Stripe.Subscription;
  try {
    subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: "default_incomplete",
      payment_settings: {
        save_default_payment_method: "on_subscription",
        payment_method_types: ["card"],
      },
      expand: ["latest_invoice.confirmation_secret", "latest_invoice.payment_intent"],
      metadata: { userId: user.id, triggerSurface },
    });
  } catch (err) {
    // Most likely a misconfigured price id (e.g. a test-mode price id or an
    // amount instead of a `price_…` id, or a live/test key mismatch). Return the
    // real Stripe message + code so the failure is legible, not an empty 500.
    console.error("[create-subscription] stripe.subscriptions.create failed:", err);
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Could not create subscription",
        code: (err as { code?: string })?.code,
      },
      { status: 502 }
    );
  }

  // Persist the subscription id now so webhook can match on either
  // stripe_subscription_id or stripe_customer_id.
  await supabase
    .from("stripe_customers")
    .update({ stripe_subscription_id: subscription.id })
    .eq("user_id", user.id);

  // Resolve client secret from whichever expanded path is populated.
  const latestInvoice = subscription.latest_invoice as
    | (Stripe.Invoice & {
        confirmation_secret?: { client_secret: string | null; type: string } | null;
        payment_intent?: Stripe.PaymentIntent | null;
      })
    | null;

  const clientSecret =
    latestInvoice?.confirmation_secret?.client_secret ??
    latestInvoice?.payment_intent?.client_secret ??
    null;

  if (!clientSecret) {
    console.error("[create-subscription] No client secret resolved. Subscription status:", subscription.status, "invoice keys:", latestInvoice ? Object.keys(latestInvoice) : "null");
    return NextResponse.json(
      { error: "Missing client secret on subscription" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    subscriptionId: subscription.id,
    clientSecret,
  });
}
