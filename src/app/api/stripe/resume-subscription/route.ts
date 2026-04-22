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
  await stripe.subscriptions.update(row.stripe_subscription_id, {
    cancel_at_period_end: false,
  });

  await supabase
    .from("stripe_customers")
    .update({ cancel_at_period_end: false, canceled_at: null })
    .eq("user_id", user.id);

  return NextResponse.json({ ok: true });
}
