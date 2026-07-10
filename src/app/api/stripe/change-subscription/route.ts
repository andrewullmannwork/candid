/**
 * POST /api/stripe/change-subscription — Switch the user's subscription
 * between billing cycles (monthly ↔ annual).
 *
 * Body: { targetCycle: 'monthly' | 'annual' }
 *
 * Pre-conditions:
 *   - User has an active Stripe subscription
 *   - STRIPE_PRO_PRICE_ID + STRIPE_PRO_ANNUAL_PRICE_ID env vars are set
 *
 * Behavior:
 *   - Looks up the current subscription via stripe_customers.stripe_subscription_id
 *   - Calls stripe.subscriptions.update() to swap the Price; Stripe handles
 *     proration automatically (immediate proration applied to next invoice)
 *   - Write-through: updates stripe_customers.tier_cycle so /billing flips
 *     immediately without waiting for the webhook round-trip
 *   - Webhook reconciles on customer.subscription.updated as the source of truth
 *
 * Returns: { ok: true, tier_cycle: 'monthly' | 'annual' }
 *
 * Auth: Firebase bearer token.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe";
import { isStripeResourceMissing, downgradeOrphanedSubscription } from "@/lib/stripe/subscription-sync";

type TargetCycle = "monthly" | "annual";

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

  const body = await req.json().catch(() => ({}));
  const targetCycle: TargetCycle | null =
    body?.targetCycle === "monthly" || body?.targetCycle === "annual"
      ? body.targetCycle
      : null;

  if (!targetCycle) {
    return NextResponse.json(
      { error: "targetCycle must be 'monthly' or 'annual'" },
      { status: 400 },
    );
  }

  const monthlyPriceId = process.env.STRIPE_PRO_PRICE_ID;
  const annualPriceId = process.env.STRIPE_PRO_ANNUAL_PRICE_ID;

  if (!monthlyPriceId || !annualPriceId) {
    return NextResponse.json(
      { error: "Stripe price IDs not configured" },
      { status: 500 },
    );
  }

  const targetPriceId = targetCycle === "annual" ? annualPriceId : monthlyPriceId;

  const supabase = createServerClient();
  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const { data: customerRow } = await supabase
    .from("stripe_customers")
    .select("stripe_subscription_id, tier_cycle, subscription_status")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!customerRow?.stripe_subscription_id) {
    return NextResponse.json({ error: "No active subscription" }, { status: 404 });
  }

  if (customerRow.subscription_status !== "active" && customerRow.subscription_status !== "trialing") {
    return NextResponse.json(
      { error: `Subscription is ${customerRow.subscription_status} — cannot switch cycle` },
      { status: 409 },
    );
  }

  if (customerRow.tier_cycle === targetCycle) {
    // Idempotent: already on the target cycle. Treat as success.
    return NextResponse.json({ ok: true, tier_cycle: targetCycle });
  }

  const stripe = getStripe();

  try {
    // Retrieve the subscription so we know which subscription item to swap.
    const subscription = await stripe.subscriptions.retrieve(
      customerRow.stripe_subscription_id,
    );

    const itemToSwap = subscription.items.data[0];
    if (!itemToSwap) {
      return NextResponse.json(
        { error: "Subscription has no items to update" },
        { status: 500 },
      );
    }

    await stripe.subscriptions.update(customerRow.stripe_subscription_id, {
      items: [{ id: itemToSwap.id, price: targetPriceId }],
      proration_behavior: "always_invoice",
    });
  } catch (err) {
    if (isStripeResourceMissing(err)) {
      // Sub is gone in Stripe — can't change a cycle on what no longer exists.
      // Self-heal to Free and tell the client to resubscribe.
      console.warn(
        `[change-subscription] subscription ${customerRow.stripe_subscription_id} missing in Stripe for user ${user.id} — downgrading to Free`,
      );
      await downgradeOrphanedSubscription(supabase, user.id);
      return NextResponse.json(
        {
          error: "subscription_not_found",
          reason: "This subscription is no longer active. Please resubscribe.",
        },
        { status: 409 },
      );
    }
    console.error("[change-subscription] Stripe change failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Stripe update failed" },
      { status: 502 },
    );
  }

  // Write-through so the UI flips before the webhook lands.
  await supabase
    .from("stripe_customers")
    .update({ tier_cycle: targetCycle })
    .eq("user_id", user.id);

  return NextResponse.json({ ok: true, tier_cycle: targetCycle });
}
