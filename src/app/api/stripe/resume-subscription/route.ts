/**
 * POST /api/stripe/resume-subscription — Undo a scheduled cancellation before
 * the period ends. Only valid when subscription is still active AND
 * cancel_at_period_end is true.
 *
 * Auth: Firebase bearer token.
 * Returns: { ok: true }
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe";
import { isStripeResourceMissing, downgradeOrphanedSubscription } from "@/lib/stripe/subscription-sync";

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

  const supabase = createServerClient();
  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const { data: row } = await supabase
    .from("stripe_customers")
    .select("stripe_subscription_id, cancel_at_period_end")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!row?.stripe_subscription_id) {
    return NextResponse.json({ error: "No subscription" }, { status: 404 });
  }
  if (!row.cancel_at_period_end) {
    return NextResponse.json({ error: "Subscription not scheduled to cancel" }, { status: 400 });
  }

  const stripe = getStripe();
  try {
    await stripe.subscriptions.update(row.stripe_subscription_id, {
      cancel_at_period_end: false,
    });
  } catch (err) {
    if (isStripeResourceMissing(err)) {
      // Sub is gone in Stripe — can't resume what no longer exists. Self-heal to
      // Free and tell the client to resubscribe.
      console.warn(
        `[resume-subscription] subscription ${row.stripe_subscription_id} missing in Stripe for user ${user.id} — downgrading to Free`,
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
    console.error("[resume-subscription] Stripe update failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Resume failed" },
      { status: 502 },
    );
  }

  await supabase
    .from("stripe_customers")
    .update({ cancel_at_period_end: false, canceled_at: null })
    .eq("user_id", user.id);

  return NextResponse.json({ ok: true });
}
