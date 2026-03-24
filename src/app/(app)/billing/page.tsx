"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { createBrowserClient } from "@/lib/supabase/client";

export default function BillingPage() {
  const { user } = useAuth();
  const [tier, setTier] = useState<string>("free");
  const [status, setStatus] = useState<string>("none");
  const [loading, setLoading] = useState(true);

  // Card form state (display-only for now — actual Stripe integration TBD)
  const [showCardForm, setShowCardForm] = useState(false);
  const [hasCard, setHasCard] = useState(false);
  const [cardLast4, setCardLast4] = useState("");

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

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-32">
        <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-lg">
      <h1 className="text-2xl font-bold text-gray-900">Billing</h1>

      {/* Current Plan */}
      <div className="mt-6 p-5 bg-white border border-gray-100 rounded-2xl">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-gray-900">
              {tier === "pro" ? "Candid Pro" : "Candid Free"}
            </h3>
            <p className="text-sm text-gray-500 mt-0.5">
              {status === "active" ? "Active subscription" : "Free tier — no charges"}
            </p>
          </div>
          <span className={`px-2.5 py-1 rounded-lg text-xs font-semibold ${
            tier === "pro" ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600"
          }`}>
            {tier === "pro" ? "Pro" : "Free"}
          </span>
        </div>
      </div>

      {/* Savings Tracker */}
      <div className="mt-4 p-5 bg-green-50 border border-green-100 rounded-2xl">
        <h3 className="text-sm font-semibold text-green-800">Estimated savings</h3>
        <p className="text-3xl font-bold text-green-700 mt-1">$0</p>
        <p className="text-xs text-green-600 mt-1">
          Upload and audit bills to start tracking how much Candid saves you.
        </p>
      </div>

      {/* Payment Method */}
      <div className="mt-4 p-5 bg-white border border-gray-100 rounded-2xl">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-900">Payment method</h3>
          {hasCard && (
            <button
              onClick={() => setShowCardForm(!showCardForm)}
              className="text-xs font-medium text-blue-600 hover:text-blue-700"
            >
              Update
            </button>
          )}
        </div>

        {hasCard ? (
          <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl">
            <div className="w-10 h-7 bg-gradient-to-br from-gray-700 to-gray-900 rounded flex items-center justify-center">
              <span className="text-white text-[10px] font-bold">VISA</span>
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900">•••• {cardLast4}</p>
              <p className="text-xs text-gray-400">Default payment method</p>
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-gray-500 mb-3">
              Add a payment method for when you upgrade to Candid Pro.
            </p>

            {!showCardForm ? (
              <button
                onClick={() => setShowCardForm(true)}
                className="w-full py-2.5 border-2 border-dashed border-gray-200 rounded-xl text-sm font-medium text-gray-500 hover:border-blue-300 hover:text-blue-600 transition-colors"
              >
                + Add credit or debit card
              </button>
            ) : (
              <div className="space-y-3 p-4 bg-gray-50 rounded-xl">
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">Card number</label>
                  <input
                    type="text"
                    placeholder="1234 5678 9012 3456"
                    maxLength={19}
                    className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-gray-600 block mb-1">Expiry</label>
                    <input
                      type="text"
                      placeholder="MM/YY"
                      maxLength={5}
                      className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-600 block mb-1">CVC</label>
                    <input
                      type="text"
                      placeholder="123"
                      maxLength={4}
                      className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>
                </div>
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => {
                      // In production, this would use Stripe Elements
                      setHasCard(true);
                      setCardLast4("4242");
                      setShowCardForm(false);
                    }}
                    className="flex-1 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 transition-colors"
                  >
                    Save card
                  </button>
                  <button
                    onClick={() => setShowCardForm(false)}
                    className="px-4 py-2.5 text-sm text-gray-500 hover:text-gray-700"
                  >
                    Cancel
                  </button>
                </div>
                <p className="text-[11px] text-gray-400 text-center">
                  Secured by Stripe. Card details are never stored on our servers.
                </p>
              </div>
            )}
          </>
        )}
      </div>

      {/* Pro Upgrade */}
      <div className="mt-4 p-5 bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-100 rounded-2xl">
        <h3 className="font-semibold text-blue-900">Candid Pro — Coming Soon</h3>
        <ul className="mt-3 space-y-2">
          {[
            "Unlimited dispute letters",
            "Full price comparison",
            "Attorney directory access",
            "Priority support",
          ].map((feature) => (
            <li key={feature} className="flex items-center gap-2 text-sm text-blue-700">
              <svg className="w-4 h-4 text-blue-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
              </svg>
              {feature}
            </li>
          ))}
        </ul>
        <button
          disabled
          className="mt-4 w-full py-2.5 bg-blue-300 text-white rounded-xl cursor-not-allowed text-sm font-semibold"
        >
          Coming Soon
        </button>
      </div>
    </div>
  );
}
