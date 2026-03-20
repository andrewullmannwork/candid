"use client";

import Link from "next/link";
import { useSubscription, type SubscriptionTier } from "./use-subscription";

interface SubscriptionGateProps {
  requiredTier: SubscriptionTier;
  featureName: string;
  children: React.ReactNode;
}

/**
 * Wraps content that requires a specific subscription tier.
 * Shows an upgrade prompt if the user's tier is insufficient.
 */
export function SubscriptionGate({
  requiredTier,
  featureName,
  children,
}: SubscriptionGateProps) {
  const { tier, loading, isPro } = useSubscription();

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

  // Show upgrade prompt
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
