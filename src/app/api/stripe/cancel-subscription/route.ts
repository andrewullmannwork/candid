/**
 * POST /api/stripe/cancel-subscription — Mark the user's active subscription
 * to cancel at the end of the current period. User retains Pro access until
 * the period ends (NEVER immediate cancellation — see Candid_Context
 * "Subscription & Billing" hard rules).
 *
 * Auth: Firebase bearer token.
 * Returns: { ok: true, periodEnd }
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { getStripe, resolveCurrentPeriodEnd } from "@/lib/stripe";

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
    .select("stripe_subscription_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!row?.stripe_subscription_id) {
    return NextResponse.json({ error: "No active subscription" }, { status: 404 });
  }

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.update(row.stripe_subscription_id, {
    cancel_at_period_end: true,
  });

  const periodEnd = resolveCurrentPeriodEnd(subscription);

  // Webhook will also mirror this, but write-through so the UI can refresh
  // immediately without waiting for the webhook round-trip.
  await supabase
    .from("stripe_customers")
    .update({
      cancel_at_period_end: true,
      canceled_at: new Date().toISOString(),
      ...(periodEnd && { current_period_end: new Date(periodEnd * 1000).toISOString() }),
    })
    .eq("user_id", user.id);

  return NextResponse.json({
    ok: true,
    periodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
  });
}
