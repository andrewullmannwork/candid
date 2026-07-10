/**
 * subscription-sync — reconcile our stripe_customers row when Stripe and our
 * DB drift apart.
 *
 * Why this exists: the cancel / resume / change routes operate on the
 * stripe_subscription_id stored in our DB. If that subscription no longer
 * exists in Stripe — a test-mode sub after a switch to live keys, a sub deleted
 * directly in the dashboard, or a missed webhook — the Stripe SDK throws a
 * `resource_missing` (404) error. Without handling, that surfaces to the user
 * as an unhandled 500 ("Cancellation failed"). Instead we self-heal: the sub is
 * gone, so the user has no active billing → downgrade the local row to Free.
 *
 * IMPORTANT: only call this on a definitive `resource_missing`. A transient
 * Stripe error (5xx / network) must NOT downgrade — that would wrongly drop a
 * paying user to Free on a blip. Use isStripeResourceMissing() to gate it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { userScoped } from "@/lib/security/user-scoped";

/** True for Stripe's "no such subscription/customer" (404) error only. */
export function isStripeResourceMissing(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code?: unknown }).code === "resource_missing"
  );
}

/**
 * Downgrade a user's stripe_customers row to Free because their subscription no
 * longer exists in Stripe. Nulls the sub id (so nothing retries a dead id and
 * create-subscription starts fresh) but KEEPS the customer id — a real user
 * whose sub ended still has a valid customer to resubscribe with.
 */
export async function downgradeOrphanedSubscription(
  supabase: SupabaseClient,
  userId: string,
): Promise<void> {
  // userScoped auto-applies .eq("user_id", userId) and routes the raw .from
  // through the B1 security layer (the no-raw-user-table-from lint backstop).
  await userScoped(supabase, userId)
    .table("stripe_customers")
    .update({
      subscription_tier: "free",
      subscription_status: "none",
      stripe_subscription_id: null,
      cancel_at_period_end: false,
      current_period_end: null,
      canceled_at: null,
    });
}
