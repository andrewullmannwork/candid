"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { createBrowserClient } from "@/lib/supabase/client";

export default function BillingPage() {
  const { user } = useAuth();
  const [tier, setTier] = useState<string>("free");
  const [status, setStatus] = useState<string>("none");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    const supabase = createBrowserClient();

    async function loadBilling() {
      const { data } = await supabase
        .from("stripe_customers")
        .select("subscription_tier, subscription_status")
        .eq("user_id", user!.userId)
        .single();

      if (data) {
        setTier(data.subscription_tier);
        setStatus(data.subscription_status);
      }
      setLoading(false);
    }

    loadBilling();
  }, [user]);

  if (loading) return <div className="text-gray-500">Loading billing info...</div>;

  return (
    <div className="max-w-lg">
      <h1 className="text-2xl font-bold text-gray-900">Billing</h1>

      <div className="mt-6 p-6 bg-white border rounded-xl">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-gray-900">
              Current Plan: {tier === "pro" ? "Candid Pro" : "Candid Free"}
            </h3>
            <p className="text-sm text-gray-500 mt-1">
              Status: {status === "active" ? "Active" : status === "none" ? "Free tier" : status}
            </p>
          </div>
        </div>
      </div>

      <div className="mt-6 p-6 bg-blue-50 border border-blue-200 rounded-xl">
        <h3 className="font-medium text-blue-900">Candid Pro — Coming Soon</h3>
        <ul className="mt-2 space-y-1 text-sm text-blue-700">
          <li>Unlimited dispute letters</li>
          <li>Full Mestimate price comparison</li>
          <li>Attorney directory access</li>
          <li>Priority support</li>
        </ul>
        <button
          disabled
          className="mt-4 px-4 py-2 bg-blue-300 text-white rounded-lg cursor-not-allowed text-sm"
        >
          Coming Soon
        </button>
      </div>
    </div>
  );
}
