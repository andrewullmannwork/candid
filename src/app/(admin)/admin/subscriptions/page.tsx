"use client";

import { useEffect, useState } from "react";

interface SubscriptionRow {
  id: string;
  stripe_customer_id: string;
  subscription_status: string;
  subscription_tier: string;
  current_period_end: string | null;
  created_at: string;
  updated_at: string;
  users: {
    id: string;
    email: string;
    display_name: string | null;
  } | null;
}

export default function AdminSubscriptionsPage() {
  const [subs, setSubs] = useState<SubscriptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionTarget, setActionTarget] = useState<string | null>(null);
  const [actionType, setActionType] = useState<"cancel" | "refund" | null>(null);
  const [reason, setReason] = useState("");
  const [processing, setProcessing] = useState(false);
  const [result, setResult] = useState<{ type: "success" | "error"; message: string } | null>(null);

  useEffect(() => {
    async function load() {
      const res = await fetch("/api/admin/subscriptions");
      const data = await res.json();
      setSubs(data.subscriptions || []);
      setLoading(false);
    }
    load();
  }, []);

  async function handleAction() {
    if (!actionTarget || !actionType) return;
    setProcessing(true);
    setResult(null);

    try {
      const res = await fetch("/api/admin/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: actionType,
          stripe_customer_id: actionTarget,
          reason,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setResult({ type: "error", message: data.error });
      } else {
        const msg =
          actionType === "refund"
            ? `Refunded $${data.amount} ${data.currency?.toUpperCase()}`
            : "Subscription canceled";
        setResult({ type: "success", message: msg });

        // Update local state for cancellation
        if (actionType === "cancel") {
          setSubs((prev) =>
            prev.map((s) =>
              s.stripe_customer_id === actionTarget
                ? { ...s, subscription_status: "canceled", subscription_tier: "free" }
                : s
            )
          );
        }
      }
    } catch {
      setResult({ type: "error", message: "Request failed" });
    }

    setProcessing(false);
    setActionType(null);
    setReason("");
  }

  const statusColor: Record<string, string> = {
    active: "bg-green-100 text-green-700",
    trialing: "bg-blue-100 text-blue-700",
    canceled: "bg-red-100 text-red-700",
    past_due: "bg-yellow-100 text-yellow-700",
    none: "bg-gray-100 text-gray-500",
  };

  if (loading) return <div className="text-gray-500">Loading subscriptions...</div>;

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Stripe Subscriptions</h1>
      <p className="mt-1 text-sm text-gray-500">
        View, cancel, and refund customer subscriptions.
      </p>

      {/* Result banner */}
      {result && (
        <div
          className={`mt-4 p-3 rounded text-sm ${
            result.type === "success"
              ? "bg-green-50 border border-green-200 text-green-800"
              : "bg-red-50 border border-red-200 text-red-800"
          }`}
        >
          {result.message}
        </div>
      )}

      {/* Confirmation dialog */}
      {actionType && actionTarget && (
        <div className="mt-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
          <p className="font-medium text-yellow-800">
            Confirm {actionType === "cancel" ? "Cancellation" : "Refund"}
          </p>
          <p className="text-sm text-yellow-700 mt-1">
            {actionType === "cancel"
              ? "This will cancel all active subscriptions for this customer."
              : "This will refund the most recent charge for this customer."}
          </p>
          <p className="text-sm text-yellow-700 mt-1">
            Customer: <code className="bg-yellow-100 px-1 rounded">{actionTarget}</code>
          </p>
          <input
            type="text"
            placeholder="Reason (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="mt-2 w-full max-w-md px-3 py-1.5 border rounded text-sm focus:ring-2 focus:ring-yellow-500 focus:outline-none"
          />
          <div className="mt-3 flex gap-2">
            <button
              onClick={handleAction}
              disabled={processing}
              className={`px-3 py-1.5 text-sm text-white rounded ${
                actionType === "cancel"
                  ? "bg-red-600 hover:bg-red-700"
                  : "bg-orange-600 hover:bg-orange-700"
              } disabled:opacity-50`}
            >
              {processing
                ? "Processing..."
                : actionType === "cancel"
                ? "Confirm Cancel"
                : "Confirm Refund"}
            </button>
            <button
              onClick={() => {
                setActionType(null);
                setActionTarget(null);
                setReason("");
              }}
              className="px-3 py-1.5 bg-gray-200 text-gray-700 text-sm rounded hover:bg-gray-300"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Subscriptions table */}
      <div className="mt-6 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-gray-500">
              <th className="pb-2 pr-4">User</th>
              <th className="pb-2 pr-4">Stripe ID</th>
              <th className="pb-2 pr-4">Status</th>
              <th className="pb-2 pr-4">Tier</th>
              <th className="pb-2 pr-4">Period End</th>
              <th className="pb-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {subs.map((s) => (
              <tr key={s.id} className="border-b">
                <td className="py-2 pr-4">
                  <div>{s.users?.email || "—"}</div>
                  {s.users?.display_name && (
                    <div className="text-xs text-gray-400">{s.users.display_name}</div>
                  )}
                </td>
                <td className="py-2 pr-4">
                  <code className="text-xs bg-gray-100 px-1 rounded">{s.stripe_customer_id}</code>
                </td>
                <td className="py-2 pr-4">
                  <span className={`px-2 py-0.5 rounded text-xs ${statusColor[s.subscription_status] || ""}`}>
                    {s.subscription_status}
                  </span>
                </td>
                <td className="py-2 pr-4 capitalize">{s.subscription_tier}</td>
                <td className="py-2 pr-4 text-gray-500">
                  {s.current_period_end
                    ? new Date(s.current_period_end).toLocaleDateString()
                    : "—"}
                </td>
                <td className="py-2">
                  <div className="flex gap-1">
                    {s.subscription_status === "active" && (
                      <button
                        onClick={() => {
                          setActionTarget(s.stripe_customer_id);
                          setActionType("cancel");
                          setResult(null);
                        }}
                        className="px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded"
                      >
                        Cancel
                      </button>
                    )}
                    <button
                      onClick={() => {
                        setActionTarget(s.stripe_customer_id);
                        setActionType("refund");
                        setResult(null);
                      }}
                      className="px-2 py-1 text-xs text-orange-600 hover:bg-orange-50 rounded"
                    >
                      Refund
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {subs.length === 0 && (
              <tr>
                <td colSpan={6} className="py-8 text-center text-gray-400">
                  No subscription records yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
