/**
 * POST /api/stripe/create-checkout — Create Stripe Checkout session
 *
 * Body:
 * - returnUrl: URL to redirect to after checkout (with ?upgraded=true param)
 *
 * Auth: Firebase bearer token.
 * Returns: { url: string } — the Stripe Checkout URL
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import Stripe from "stripe";

// Lazy-init Stripe so the module can load at build time when the env var
// isn't set (e.g. in CI). We instantiate only when the route actually runs.
function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY not configured");
  }
  return new Stripe(key, { apiVersion: "2026-02-25.clover" });
}

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
    .select("id, email")
    .eq("firebase_uid", decoded.uid)
    .single();

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const body = await req.json();
  const returnUrl = body.returnUrl || `${process.env.NEXT_PUBLIC_APP_URL || "https://candidclaim.com"}/billing`;

  // Get or create Stripe customer
  const { data: existingCustomer } = await supabase
    .from("stripe_customers")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .maybeSingle();

  let customerId = existingCustomer?.stripe_customer_id;

  if (!customerId) {
    const customer = await getStripe().customers.create({
      email: user.email,
      metadata: { userId: user.id },
    });
    customerId = customer.id;

    await supabase.from("stripe_customers").insert({
      user_id: user.id,
      stripe_customer_id: customerId,
      subscription_status: "none",
      subscription_tier: "free",
    });
  }

  // Create checkout session
  const priceId = process.env.STRIPE_PRO_PRICE_ID;
  if (!priceId) {
    return NextResponse.json({ error: "Stripe price not configured" }, { status: 500 });
  }

  // Append ?upgraded=true to return URL so the page can auto-trigger download
  const successUrl = returnUrl.includes("?")
    ? `${returnUrl}&upgraded=true`
    : `${returnUrl}?upgraded=true`;

  const session = await getStripe().checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: returnUrl,
    metadata: { userId: user.id },
  });

  return NextResponse.json({ url: session.url });
}
