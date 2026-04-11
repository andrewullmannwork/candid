"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { createBrowserClient } from "@/lib/supabase/client";

export type SubscriptionTier = "free" | "pro";
export type SubscriptionStatus = "none" | "trialing" | "active" | "canceled" | "past_due";

export interface SubscriptionState {
  tier: SubscriptionTier;
  status: SubscriptionStatus;
  loading: boolean;
  isPro: boolean;
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

export function useSubscription(): SubscriptionState {
  const { user } = useAuth();
  const [tier, setTier] = useState<SubscriptionTier>("free");
  const [status, setStatus] = useState<SubscriptionStatus>("none");
  const [loading, setLoading] = useState(() => !!user);

  useEffect(() => {
    if (!user) {
      return;
    }

    const supabase = createBrowserClient();

    async function loadSubscription() {
      const { data } = await supabase
        .from("stripe_customers")
        .select("subscription_tier, subscription_status")
        .eq("user_id", user!.userId)
        .single();

      if (data) {
        setTier(data.subscription_tier || "free");
        setStatus(data.subscription_status || "none");
      }
      setLoading(false);
    }

    loadSubscription();
  }, [user]);

  return {
    tier,
    status,
    loading,
    isPro: tier === "pro" && (status === "active" || status === "trialing"),
  };
}

export function canAccessFeature(
  tier: SubscriptionTier,
  requiredTier: SubscriptionTier
): boolean {
  if (requiredTier === "free") return true;
  return tier === "pro";
}
