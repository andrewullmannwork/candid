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
