import Stripe from "stripe";

/** Lazily initialized Stripe client — avoids build-time initialization errors. */
let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: "2026-02-25.clover",
    });
  }
  return _stripe;
}

// Re-export for convenience
export { Stripe };

/**
 * Resolve a Stripe Subscription's `current_period_end` (Unix seconds).
 *
 * Stripe API 2025+/Clover moved this field off the Subscription object and
 * onto each Subscription Item — `subscription.items.data[i].current_period_end`.
 * Some library versions still surface it on the Subscription too. Read from
 * the item first (authoritative on Clover), then fall back to the
 * subscription-level field for back-compat with older shapes.
 *
 * Returns null if neither shape provides a value.
 */
export function resolveCurrentPeriodEnd(
  subscription: Stripe.Subscription,
): number | null {
  const itemPeriodEnd = (
    subscription.items?.data?.[0] as unknown as
      | { current_period_end?: number }
      | undefined
  )?.current_period_end;
  if (typeof itemPeriodEnd === "number") return itemPeriodEnd;

  const subPeriodEnd = (
    subscription as unknown as { current_period_end?: number }
  ).current_period_end;
  return typeof subPeriodEnd === "number" ? subPeriodEnd : null;
}
