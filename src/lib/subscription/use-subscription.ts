"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/lib/auth/auth-context";

export type SubscriptionTier = "free" | "pro";
export type SubscriptionStatus = "none" | "trialing" | "active" | "canceled" | "past_due";

export interface SubscriptionState {
  tier: SubscriptionTier;
  status: SubscriptionStatus;
  loading: boolean;
  isPro: boolean;
  cancelAtPeriodEnd: boolean;
  periodEnd: string | null;
  /** Re-fetch subscription state from the DB. Call after mutating actions
   *  (subscribe / cancel / resume) so UI flips immediately instead of
   *  waiting for the webhook round-trip. */
  refresh: () => Promise<void>;
  /** Poll refresh() until the predicate is true or timeout fires. Use after
   *  Stripe confirmPayment returns so the UI waits for the webhook to flip
   *  tier before dismissing the subscribe form. */
  waitFor: (
    predicate: (state: {
      tier: SubscriptionTier;
      status: SubscriptionStatus;
      cancelAtPeriodEnd: boolean;
    }) => boolean,
    opts?: { timeoutMs?: number; intervalMs?: number }
  ) => Promise<boolean>;
}

// Features gated by subscription tier
export const FEATURE_ACCESS = {
  // Alpha — free
  candidClaim: "free" as SubscriptionTier, // Free audit
  candidPlan: "free" as SubscriptionTier, // Free benefits check

  // Beta — paid
  disputeLetters: "pro" as SubscriptionTier, // Dispute letter generation
  documentationAggregation: "pro" as SubscriptionTier, // Case file compilation
  candidCase: "pro" as SubscriptionTier, // Attorney marketplace

  // Full Launch — paid
  candidCare: "pro" as SubscriptionTier, // Price transparency (also gated by data volume)
};

interface ApiMe {
  tier: SubscriptionTier;
  status: SubscriptionStatus;
  cancelAtPeriodEnd: boolean;
  periodEnd: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  cardExpMonth: number | null;
  cardExpYear: number | null;
}

/**
 * Fetch the authenticated user's subscription state via the server API.
 * We route through /api/subscription/me rather than hitting stripe_customers
 * directly with the browser client because that table's RLS policy uses
 * auth.uid() (Supabase auth) which is always null in a Firebase-auth app.
 */
async function fetchSubscription(getToken: () => Promise<string>): Promise<ApiMe | null> {
  const token = await getToken();
  const res = await fetch("/api/subscription/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as ApiMe;
}

export function useSubscription(): SubscriptionState {
  const { user } = useAuth();
  const [tier, setTier] = useState<SubscriptionTier>("free");
  const [status, setStatus] = useState<SubscriptionStatus>("none");
  const [cancelAtPeriodEnd, setCancelAtPeriodEnd] = useState(false);
  const [periodEnd, setPeriodEnd] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => !!user);

  const [refreshTick, setRefreshTick] = useState(0);
  const resolversRef = useRef<Array<() => void>>([]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    async function run() {
      const data = await fetchSubscription(() => user!.firebaseUser.getIdToken());
      if (cancelled) return;
      if (data) {
        setTier(data.tier);
        setStatus(data.status);
        setCancelAtPeriodEnd(data.cancelAtPeriodEnd);
        setPeriodEnd(data.periodEnd);
      }
      setLoading(false);
      // Resolve any pending refresh() promises so callers can await reloads.
      const pending = resolversRef.current;
      resolversRef.current = [];
      pending.forEach((resolve) => resolve());
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [user, refreshTick]);

  const refresh = useCallback(() => {
    return new Promise<void>((resolve) => {
      resolversRef.current.push(resolve);
      setRefreshTick((t) => t + 1);
    });
  }, []);

  /**
   * Poll refresh() until the predicate returns true, or we hit the timeout.
   * Used after subscribe/cancel/resume to bridge the gap between Stripe
   * accepting the action and the webhook updating our DB. Returns the final
   * value of the predicate (true on success, false on timeout).
   */
  const waitFor = useCallback(
    async (
      predicate: (state: {
        tier: SubscriptionTier;
        status: SubscriptionStatus;
        cancelAtPeriodEnd: boolean;
      }) => boolean,
      opts: { timeoutMs?: number; intervalMs?: number } = {}
    ): Promise<boolean> => {
      const timeoutMs = opts.timeoutMs ?? 8000;
      const intervalMs = opts.intervalMs ?? 500;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await refresh();
        if (!user) return false;
        // Read fresh state directly from the API rather than trusting the
        // hook's state, which batches through React and can lag by a render.
        const data = await fetchSubscription(() => user.firebaseUser.getIdToken());
        if (
          data &&
          predicate({
            tier: data.tier,
            status: data.status,
            cancelAtPeriodEnd: data.cancelAtPeriodEnd,
          })
        ) {
          return true;
        }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      return false;
    },
    [refresh, user]
  );

  return {
    tier,
    status,
    loading,
    isPro: tier === "pro" && (status === "active" || status === "trialing"),
    cancelAtPeriodEnd,
    periodEnd,
    refresh,
    waitFor,
  };
}

export function canAccessFeature(
  tier: SubscriptionTier,
  requiredTier: SubscriptionTier
): boolean {
  if (requiredTier === "free") return true;
  return tier === "pro";
}
