/**
 * Subscription tier predicate — the single source of truth for "is this user on
 * a paying Stream-1 (Pro) tier?" Shared by the client hook (use-subscription)
 * and every server-side gate (dispute generation, Case File, redraft, evidence
 * package) so the client and server can never drift on who counts as paid.
 *
 * Pure + isomorphic: no "use client", no I/O, no React. Safe to import from API
 * routes and React components alike.
 *
 * Block B of the Dispute Letter Overhaul arc
 * (plans/dispute_letter_overhaul.md §5; P6 — server-side subscription gate).
 */

export type SubscriptionTier = "free" | "pro";
export type SubscriptionStatus =
  | "none"
  | "trialing"
  | "active"
  | "canceled"
  | "past_due";
export type TierCycle = "monthly" | "annual";

/**
 * True only when the user holds the Pro tier AND the subscription is currently
 * in good standing. A `past_due` row keeps `tier: "pro"` (the
 * invoice.payment_failed webhook flips status but not tier — see
 * api/stripe/webhook) yet is NOT paid: checking tier alone (the legacy
 * `canAccessFeature`) would wrongly grant a delinquent subscriber access. This
 * predicate matches the client's `isPro` exactly so server and client agree.
 */
export function isPaidTier(
  tier: SubscriptionTier | null | undefined,
  status: SubscriptionStatus | null | undefined,
): boolean {
  return tier === "pro" && (status === "active" || status === "trialing");
}
