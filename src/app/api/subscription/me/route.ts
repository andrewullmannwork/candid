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
 *   tierCycle: 'monthly' | 'annual',
 *   cancelAtPeriodEnd: boolean,
 *   periodEnd: string | null,
 *   cardBrand: string | null,
 *   cardLast4: string | null,
 *   cardExpMonth: number | null,
 *   cardExpYear: number | null,
 *   cardholderName: string | null,
 *   pastDueRetryLog: PastDueRetryEvent[] | null,
 * }
 *
 * Stripe API calls (cardholder name + past-due retry log) only happen when
 * pre-conditions are met (card on file present + status === 'past_due')
 * so the common path stays a single Supabase query.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe";
import type Stripe from "stripe";

export interface PastDueRetryEvent {
  /** Unix-ms timestamp for ordering. */
  at: string;
  /** 'failed' = past attempt; 'scheduled' = upcoming retry. */
  kind: "failed" | "scheduled";
  /** Short-form card label (e.g. "Visa ····4242"). Null if unavailable. */
  cardLabel: string | null;
  /** Human-readable detail (decline reason or "Next retry scheduled"). */
  detail: string;
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

async function fetchCardholderName(
  stripe: Stripe,
  paymentMethodId: string,
): Promise<string | null> {
  try {
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
    const name = pm.billing_details?.name;
    return typeof name === "string" && name.trim() ? name.trim() : null;
  } catch (err) {
    console.warn("[subscription/me] paymentMethods.retrieve failed:", err);
    return null;
  }
}

async function fetchPastDueRetryLog(
  stripe: Stripe,
  customerId: string,
): Promise<PastDueRetryEvent[]> {
  const events: PastDueRetryEvent[] = [];

  try {
    // Last 3 failed charges in the recent window.
    const failedCharges = await stripe.charges.list({
      customer: customerId,
      limit: 3,
    });

    for (const ch of failedCharges.data) {
      if (ch.status !== "failed") continue;
      const brand = ch.payment_method_details?.card?.brand;
      const last4 = ch.payment_method_details?.card?.last4;
      const cardLabel =
        brand && last4
          ? `${brand.charAt(0).toUpperCase() + brand.slice(1)} ····${last4}`
          : null;
      const reason = ch.failure_message || "Card declined";
      events.push({
        at: new Date(ch.created * 1000).toISOString(),
        kind: "failed",
        cardLabel,
        detail: `Failed — ${reason}`,
      });
    }
  } catch (err) {
    console.warn("[subscription/me] charges.list failed:", err);
  }

  try {
    // Next scheduled retry — open invoice's next_payment_attempt.
    const openInvoices = await stripe.invoices.list({
      customer: customerId,
      status: "open",
      limit: 1,
    });
    const openInvoice = openInvoices.data[0];
    if (openInvoice?.next_payment_attempt) {
      events.push({
        at: new Date(openInvoice.next_payment_attempt * 1000).toISOString(),
        kind: "scheduled",
        cardLabel: null,
        detail: "Next retry scheduled",
      });
    }
  } catch (err) {
    console.warn("[subscription/me] invoices.list failed:", err);
  }

  // Order: failed events oldest→newest, then scheduled event(s) at the end.
  events.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "failed" ? -1 : 1;
    return a.at.localeCompare(b.at);
  });

  return events;
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

  const { data: row, error: rowError } = await supabase
    .from("stripe_customers")
    .select(
      "stripe_customer_id, default_payment_method_id, subscription_tier, subscription_status, tier_cycle, cancel_at_period_end, current_period_end, card_brand, card_last4, card_exp_month, card_exp_year",
    )
    .eq("user_id", user.id)
    .maybeSingle();

  // Surface real query errors (e.g. missing column, network failure) as 500
  // instead of silently degrading to all-null. A null-row with no error is
  // a legitimate "no subscription yet" case — that we treat as Free.
  if (rowError) {
    console.error("[subscription/me] stripe_customers query failed:", rowError);
    return NextResponse.json({ error: "subscription_query_failed" }, { status: 500 });
  }

  // Lazy Stripe calls — only when pre-conditions hit.
  let cardholderName: string | null = null;
  let pastDueRetryLog: PastDueRetryEvent[] | null = null;

  if (row?.stripe_customer_id) {
    const needsCardholderName = !!row.default_payment_method_id && !!row.card_last4;
    const needsRetryLog = row.subscription_status === "past_due";

    if (needsCardholderName || needsRetryLog) {
      const stripe = getStripe();
      const promises: Array<Promise<unknown>> = [];

      if (needsCardholderName) {
        promises.push(
          fetchCardholderName(stripe, row.default_payment_method_id as string).then(
            (name) => {
              cardholderName = name;
            },
          ),
        );
      }
      if (needsRetryLog) {
        promises.push(
          fetchPastDueRetryLog(stripe, row.stripe_customer_id).then((log) => {
            pastDueRetryLog = log;
          }),
        );
      }

      await Promise.all(promises);
    }
  }

  return NextResponse.json({
    tier: row?.subscription_tier || "free",
    status: row?.subscription_status || "none",
    tierCycle: row?.tier_cycle || "monthly",
    cancelAtPeriodEnd: !!row?.cancel_at_period_end,
    periodEnd: row?.current_period_end || null,
    cardBrand: row?.card_brand || null,
    cardLast4: row?.card_last4 || null,
    cardExpMonth: row?.card_exp_month ?? null,
    cardExpYear: row?.card_exp_year ?? null,
    cardholderName,
    pastDueRetryLog,
  });
}
