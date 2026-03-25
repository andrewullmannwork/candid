import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { getStripe } from "@/lib/stripe";

async function verifyAdmin(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    const supabase = createServerClient();
    const { data: user } = await supabase
      .from("users")
      .select("id, is_admin")
      .eq("firebase_uid", decoded.uid)
      .single();
    return user?.is_admin ? user : null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const admin = await verifyAdmin(req);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();

  const { data, error } = await supabase
    .from("stripe_customers")
    .select(`
      id, stripe_customer_id, subscription_status, subscription_tier,
      current_period_end, created_at, updated_at,
      users (id, email, display_name)
    `)
    .order("updated_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ subscriptions: data });
}

export async function POST(req: NextRequest) {
  const admin = await verifyAdmin(req);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { action, stripe_customer_id, reason } = await req.json();

  if (!stripe_customer_id || !action) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const stripe = getStripe();
  const supabase = createServerClient();

  try {
    if (action === "cancel") {
      // List active subscriptions for this customer and cancel them
      const subs = await stripe.subscriptions.list({
        customer: stripe_customer_id,
        status: "active",
      });

      for (const sub of subs.data) {
        await stripe.subscriptions.cancel(sub.id, {
          cancellation_details: { comment: reason || "Admin cancellation" },
        });
      }

      await supabase
        .from("stripe_customers")
        .update({ subscription_status: "canceled", subscription_tier: "free" })
        .eq("stripe_customer_id", stripe_customer_id);

      return NextResponse.json({ success: true, action: "canceled" });
    }

    if (action === "refund") {
      // Find the latest charge for this customer and refund it
      const charges = await stripe.charges.list({
        customer: stripe_customer_id,
        limit: 1,
      });

      if (charges.data.length === 0) {
        return NextResponse.json({ error: "No charges found to refund" }, { status: 404 });
      }

      const charge = charges.data[0];
      await stripe.refunds.create({
        charge: charge.id,
        reason: "requested_by_customer",
        metadata: { admin_reason: reason || "Admin refund" },
      });

      return NextResponse.json({
        success: true,
        action: "refunded",
        amount: charge.amount / 100,
        currency: charge.currency,
      });
    }

    return NextResponse.json({ error: "Invalid action. Use 'cancel' or 'refund'." }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Stripe operation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
