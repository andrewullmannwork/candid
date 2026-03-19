import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe";

export async function POST(req: NextRequest) {
  try {
    const { idToken } = await req.json();
    if (!idToken) {
      return NextResponse.json({ error: "Missing idToken" }, { status: 400 });
    }

    // 1. Verify Firebase token
    const decoded = await getAdminAuth().verifyIdToken(idToken);
    const { uid, email, name } = decoded;

    if (!email) {
      return NextResponse.json({ error: "No email in token" }, { status: 400 });
    }

    const supabase = createServerClient();

    // 2. Upsert user in Supabase
    const { data: existingUser } = await supabase
      .from("users")
      .select("id")
      .eq("firebase_uid", uid)
      .single();

    let userId: string;

    if (existingUser) {
      userId = existingUser.id;
      // Update email/name if changed
      await supabase
        .from("users")
        .update({ email, display_name: name || null })
        .eq("id", userId);
    } else {
      const { data: newUser, error } = await supabase
        .from("users")
        .insert({ firebase_uid: uid, email, display_name: name || null })
        .select("id")
        .single();

      if (error || !newUser) {
        return NextResponse.json({ error: "Failed to create user" }, { status: 500 });
      }
      userId = newUser.id;
    }

    // 3. Ensure Stripe Customer exists
    const { data: stripeRecord } = await supabase
      .from("stripe_customers")
      .select("stripe_customer_id")
      .eq("user_id", userId)
      .single();

    let stripeCustomerId: string;

    if (stripeRecord) {
      stripeCustomerId = stripeRecord.stripe_customer_id;
    } else {
      const customer = await getStripe().customers.create({
        email,
        metadata: { meddit_user_id: userId, firebase_uid: uid },
      });
      stripeCustomerId = customer.id;

      await supabase.from("stripe_customers").insert({
        user_id: userId,
        stripe_customer_id: stripeCustomerId,
      });
    }

    return NextResponse.json({
      userId,
      email,
      stripeCustomerId,
    });
  } catch (error) {
    console.error("Auth sync error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
