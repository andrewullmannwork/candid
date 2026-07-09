/**
 * /api/admin/subscriptions — Stripe subscription admin surface (stripe_customers).
 *   GET  — list every customer with subscription status/tier + user join.
 *   POST — { action: 'cancel' | 'refund', stripe_customer_id, reason? }. Cancel
 *          ends all active Stripe subs and marks the row canceled/free; refund
 *          refunds the customer's latest charge. Both write an admin_audit_log row.
 *
 * Auth: requireAdmin (Firebase bearer token + users.is_admin).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe";
import { requireAdmin } from "@/lib/admin/require-admin";
import { logAdminAction } from "@/lib/admin/audit-log";

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return admin.response;

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
  const admin = await requireAdmin(req);
  if (!admin.ok) return admin.response;

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

      await logAdminAction({
        adminUserId: admin.adminUserId,
        adminEmail: admin.adminEmail,
        action: "subscription_cancel",
        targetTable: "stripe_customers",
        details: `customer=${stripe_customer_id} · canceled ${subs.data.length} active subscription(s) · reason=${reason || "—"}`,
        ipAddress: req.headers.get("x-forwarded-for"),
      });

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

      await logAdminAction({
        adminUserId: admin.adminUserId,
        adminEmail: admin.adminEmail,
        action: "subscription_refund",
        targetTable: "stripe_customers",
        details: `customer=${stripe_customer_id} · refunded ${(charge.amount / 100).toFixed(2)} ${charge.currency} · reason=${reason || "—"}`,
        ipAddress: req.headers.get("x-forwarded-for"),
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
