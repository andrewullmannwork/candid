"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth/auth-context";
import { useSubscription, type SubscriptionTier } from "./use-subscription";

interface SubscriptionGateProps {
  requiredTier: SubscriptionTier;
  featureName: string;
  children: React.ReactNode;
  /** Action-level gating: wraps a button instead of a page section */
  action?: "download" | "export" | "submit";
  /** Called after successful upgrade to auto-trigger the gated action */
  onUpgrade?: () => void;
}

/**
 * Wraps content that requires a specific subscription tier.
 *
 * Two modes:
 * - Page-level (default): shows full upgrade prompt replacing children
 * - Action-level (action prop): shows inline upgrade prompt at the button
 */
export function SubscriptionGate({
  requiredTier,
  featureName,
  children,
  action,
}: SubscriptionGateProps) {
  const { user } = useAuth();
  const { tier, loading, isPro } = useSubscription();
  const [checkoutLoading, setCheckoutLoading] = useState(false);

  if (loading) {
    return <div className="text-gray-500 py-4">Loading...</div>;
  }

  // Free features are always accessible
  if (requiredTier === "free") {
    return <>{children}</>;
  }

  // Pro features require active subscription
  if (requiredTier === "pro" && isPro) {
    return <>{children}</>;
  }

  // Action-level gate: inline upgrade prompt at the button
  if (action) {
    return (
      <div className="relative">
        <div className="opacity-50 pointer-events-none">{children}</div>
        <div className="absolute inset-0 flex items-center justify-center">
          <button
            onClick={async () => {
              if (!user || checkoutLoading) return;
              setCheckoutLoading(true);
              try {
                const token = await user.firebaseUser.getIdToken();
                const res = await fetch("/api/stripe/create-checkout", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                  },
                  body: JSON.stringify({
                    returnUrl: window.location.href,
                  }),
                });
                if (res.ok) {
                  const { url } = await res.json();
                  if (url) window.location.href = url;
                }
              } catch {
                // Silent
              }
              setCheckoutLoading(false);
            }}
            disabled={checkoutLoading}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 disabled:opacity-50 transition-colors shadow-lg"
          >
            {checkoutLoading ? "Loading..." : `Upgrade to ${action}`}
          </button>
        </div>
      </div>
    );
  }

  // Page-level gate: full upgrade prompt
  return (
    <div className="max-w-lg mx-auto mt-8">
      <div className="p-6 bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200 rounded-xl text-center">
        <div className="text-3xl mb-3">🔒</div>
        <h2 className="text-lg font-semibold text-gray-900">
          {featureName} requires Candid Pro
        </h2>
        <p className="mt-2 text-gray-600">
          Upgrade to access dispute letter generation, case documentation, the
          attorney marketplace, and price transparency tools.
        </p>
        <div className="mt-4 flex flex-col items-center gap-2">
          <Link
            href="/billing"
            className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
          >
            Upgrade to Pro
          </Link>
          <span className="text-xs text-gray-500">
            Your current plan: <span className="font-medium capitalize">{tier}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
