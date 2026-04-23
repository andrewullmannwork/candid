/**
 * GET /api/subscription/me — Return the authenticated user's subscription state.
 *
 * Why this exists: `stripe_customers` has an RLS policy keyed on auth.uid()
 * (Supabase auth). Candid uses Firebase auth, so the browser's anon-key
 * client has no Supabase session → auth.uid() is NULL → RLS blocks the
 * SELECT → useSubscription reads nothing → tier always appears as 'free'.
 *
 * This route authenticates via Firebase bearer token and reads with the
 * service role (bypasses RLS) so the client can get accurate state.
 *
 * Auth: Firebase bearer token.
 * Returns: {
 *   tier: 'free' | 'pro',
 *   status: 'none' | 'trialing' | 'active' | 'canceled' | 'past_due',
 *   cancelAtPeriodEnd: boolean,
 *   periodEnd: string | null,
 *   cardBrand: string | null,
 *   cardLast4: string | null,
 *   cardExpMonth: number | null,
 *   cardExpYear: number | null,
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
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
    .select(
      "subscription_tier, subscription_status, cancel_at_period_end, current_period_end, card_brand, card_last4, card_exp_month, card_exp_year"
    )
    .eq("user_id", user.id)
    .maybeSingle();

  return NextResponse.json({
    tier: row?.subscription_tier || "free",
    status: row?.subscription_status || "none",
    cancelAtPeriodEnd: !!row?.cancel_at_period_end,
    periodEnd: row?.current_period_end || null,
    cardBrand: row?.card_brand || null,
    cardLast4: row?.card_last4 || null,
    cardExpMonth: row?.card_exp_month ?? null,
    cardExpYear: row?.card_exp_year ?? null,
  });
}
