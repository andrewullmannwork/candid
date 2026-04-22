/**
 * POST /api/stripe/create-setup-intent — Create a Stripe SetupIntent for
 * attaching or updating a payment method without creating a subscription.
 *
 * Used by /billing "Update card" flow and Free-tier "Add a card" flow.
 *
 * Auth: Firebase bearer token.
 * Returns: { clientSecret }
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
    .select("id, email")
    .eq("firebase_uid", decoded.uid)
    .single();

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const stripe = getStripe();

  const { data: existingCustomer } = await supabase
    .from("stripe_customers")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .maybeSingle();

  let customerId = existingCustomer?.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
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

  const setupIntent = await stripe.setupIntents.create({
    customer: customerId,
    payment_method_types: ["card"],
    usage: "off_session",
    metadata: { userId: user.id },
  });

  if (!setupIntent.client_secret) {
    return NextResponse.json(
      { error: "Missing client secret on setup intent" },
      { status: 500 }
    );
  }

  return NextResponse.json({ clientSecret: setupIntent.client_secret });
}
