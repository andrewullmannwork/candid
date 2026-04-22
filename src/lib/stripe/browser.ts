import { loadStripe, type Stripe } from "@stripe/stripe-js";

/**
 * Browser-side Stripe singleton. loadStripe() performs a network fetch the
 * first time it's called; caching the promise means every `<Elements>`
 * provider in the app reuses the same instance instead of re-downloading
 * stripe.js on every modal open.
 */
let _stripePromise: Promise<Stripe | null> | null = null;

export function getStripeBrowser(): Promise<Stripe | null> {
  if (_stripePromise) return _stripePromise;
  const key = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  if (!key) {
    console.error("[stripe/browser] NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY not set");
    return Promise.resolve(null);
  }
  _stripePromise = loadStripe(key);
  return _stripePromise;
}
