import { NextRequest, NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe";
import { createServerClient } from "@/lib/supabase/server";
import type Stripe from "stripe";

export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const supabase = createServerClient();

  // Idempotency — Stripe retries on network hiccups. Insert the event_id
  // first; if it already exists we skip processing entirely.
  const { error: dedupError } = await supabase
    .from("stripe_events")
    .insert({ event_id: event.id, type: event.type });

  if (dedupError) {
    // Unique-constraint violation → already processed. Return success so
    // Stripe stops retrying.
    if (dedupError.code === "23505") {
      return NextResponse.json({ received: true, dedup: true });
    }
    console.error("[stripe-webhook] Dedup insert failed (continuing):", dedupError);
  }

  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;

        // In Stripe API 2025+, current_period_end may live on subscription items
        const periodEnd = (subscription as unknown as Record<string, unknown>).current_period_end as number | undefined;

        await supabase
          .from("stripe_customers")
          .update({
            stripe_subscription_id: subscription.id,
            subscription_status: mapStripeStatus(subscription.status),
            subscription_tier: subscription.status === "active" || subscription.status === "trialing"
              ? "pro"
              : "free",
            cancel_at_period_end: subscription.cancel_at_period_end ?? false,
            canceled_at: subscription.canceled_at
              ? new Date(subscription.canceled_at * 1000).toISOString()
              : null,
            ...(periodEnd && {
              current_period_end: new Date(periodEnd * 1000).toISOString(),
            }),
          })
          .eq("stripe_customer_id", customerId);
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;

        await supabase
          .from("stripe_customers")
          .update({
            subscription_status: "canceled",
            subscription_tier: "free",
            current_period_end: null,
            cancel_at_period_end: false,
          })
          .eq("stripe_customer_id", customerId);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = invoice.customer as string;

        await supabase
          .from("stripe_customers")
          .update({ subscription_status: "past_due" })
          .eq("stripe_customer_id", customerId);
        break;
      }

      case "customer.updated": {
        const customer = event.data.object as Stripe.Customer;
        const defaultPm =
          (customer.invoice_settings?.default_payment_method as string | null | undefined) ??
          null;

        if (defaultPm) {
          const pm = await getStripe().paymentMethods.retrieve(defaultPm);
          await supabase
            .from("stripe_customers")
            .update({
              default_payment_method_id: defaultPm,
              card_brand: pm.card?.brand ?? null,
              card_last4: pm.card?.last4 ?? null,
              card_exp_month: pm.card?.exp_month ?? null,
              card_exp_year: pm.card?.exp_year ?? null,
            })
            .eq("stripe_customer_id", customer.id);
        }
        break;
      }

      case "payment_method.attached": {
        const pm = event.data.object as Stripe.PaymentMethod;
        const customerId = pm.customer as string | null;
        if (!customerId) break;

        // If this PM is the customer's default, refresh card denorm columns.
        // Otherwise just record the id — default is set via customer.updated.
        await supabase
          .from("stripe_customers")
          .update({
            card_brand: pm.card?.brand ?? null,
            card_last4: pm.card?.last4 ?? null,
            card_exp_month: pm.card?.exp_month ?? null,
            card_exp_year: pm.card?.exp_year ?? null,
          })
          .eq("stripe_customer_id", customerId);
        break;
      }

      case "payment_method.detached": {
        const pm = event.data.object as Stripe.PaymentMethod;
        // Detached PMs don't carry `customer` in the payload; detachment is
        // only meaningful if this was the default. Clear denorm columns if
        // it matches; otherwise leave them alone.
        if (pm.id) {
          await supabase
            .from("stripe_customers")
            .update({
              default_payment_method_id: null,
              card_brand: null,
              card_last4: null,
              card_exp_month: null,
              card_exp_year: null,
            })
            .eq("default_payment_method_id", pm.id);
        }
        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = invoice.customer as string;
        // First successful payment on an incomplete subscription flips status
        // to active. customer.subscription.updated will also fire, but
        // updating here makes the tier flip immediate for users who race
        // to refresh after modal success.
        await supabase
          .from("stripe_customers")
          .update({
            subscription_status: "active",
            subscription_tier: "pro",
          })
          .eq("stripe_customer_id", customerId);
        break;
      }

      default:
        // Unhandled event type — log but don't fail.
        console.log(`Unhandled Stripe event: ${event.type}`);
    }
  } catch (err) {
    console.error("Webhook processing error:", err);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

function mapStripeStatus(
  status: Stripe.Subscription.Status
): "none" | "trialing" | "active" | "canceled" | "past_due" {
  switch (status) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "canceled":
    case "unpaid":
    case "incomplete_expired":
      return "canceled";
    case "past_due":
    case "incomplete":
      return "past_due";
    default:
      return "none";
  }
}
