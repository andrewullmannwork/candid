/**
 * Server-side subscription state — the missing counterpart to the client
 * `useSubscription` hook. Reads the authoritative tier from `stripe_customers`
 * with the service-role client: Candid uses Firebase auth, so that table's
 * auth.uid()-keyed RLS would block a server read (the same reason
 * /api/subscription/me uses the service role).
 *
 * Used by the server-side Stream-1 tier gate on the dispute-artifact endpoints
 * (generate / case-file / redraft / evidence-package). Block B of the Dispute
 * Letter Overhaul arc (plans/dispute_letter_overhaul.md §5; P6).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isPaidTier,
  type SubscriptionStatus,
  type SubscriptionTier,
} from "./tier";

export interface ServerSubscription {
  tier: SubscriptionTier;
  status: SubscriptionStatus;
  /** tier === 'pro' AND status in (active, trialing) — see {@link isPaidTier}. */
  isPro: boolean;
}

/**
 * Resolve the user's current subscription tier server-side. A missing row is a
 * legitimate "never subscribed" → Free. A query error or thrown exception
 * FAILS CLOSED (`isPro: false`): a transient billing-table fault must never
 * silently grant a paid feature.
 */
export async function loadServerSubscription(
  supabase: SupabaseClient,
  userId: string,
): Promise<ServerSubscription> {
  try {
    const { data, error } = await supabase
      .from("stripe_customers")
      .select("subscription_tier, subscription_status")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) {
      console.error(
        "[subscription/server] stripe_customers read failed (fail-closed → free):",
        error,
      );
      return { tier: "free", status: "none", isPro: false };
    }
    const tier = (data?.subscription_tier as SubscriptionTier) ?? "free";
    const status = (data?.subscription_status as SubscriptionStatus) ?? "none";
    return { tier, status, isPro: isPaidTier(tier, status) };
  } catch (err) {
    console.error(
      "[subscription/server] loadServerSubscription threw (fail-closed → free):",
      err,
    );
    return { tier: "free", status: "none", isPro: false };
  }
}
