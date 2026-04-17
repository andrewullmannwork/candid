"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth/auth-context";

interface Followup {
  id: string;
  followup_type: string;
  due_date: string;
  dispute: {
    id: string;
    dispute_type: string;
    status: string;
    amount_disputed: number;
    filed_date: string;
  };
}

const TYPE_LABELS: Record<string, string> = {
  internal_appeal: "Insurance Appeal",
  external_appeal: "External Appeal",
  complaint: "Complaint",
  legal: "Legal Action",
  negotiation: "Billing Dispute",
};

export function FollowupBanner() {
  const { user } = useAuth();
  const [followups, setFollowups] = useState<Followup[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [showOutcome, setShowOutcome] = useState(false);
  const [recoveredAmount, setRecoveredAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!user) return;

    async function loadFollowups() {
      try {
        const token = await user!.firebaseUser.getIdToken();
        const res = await fetch("/api/disputes/followups", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          setFollowups(data.followups || []);
        }
      } catch {
        // Silent — banner is non-critical
      }
    }
    loadFollowups();
  }, [user]);

  const [now] = useState(() => Date.now());
  const current = followups[activeIndex] ?? null;

  if (followups.length === 0 || !current) return null;

  const daysAgo = Math.floor(
    (now - new Date(current.dispute.filed_date).getTime()) / (1000 * 60 * 60 * 24)
  );
  const typeLabel = TYPE_LABELS[current.dispute.dispute_type] || current.dispute.dispute_type;
  const isFinal = current.followup_type === "final";

  async function handleAction(action: string, amount?: number) {
    if (submitting) return;
    setSubmitting(true);

    try {
      const token = await user!.firebaseUser.getIdToken();
      const res = await fetch("/api/disputes/followups", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          followupId: current.id,
          action,
          amountRecovered: amount,
        }),
      });

      if (res.ok) {
        // Remove this followup from list
        const next = followups.filter((_, i) => i !== activeIndex);
        setFollowups(next);
        setActiveIndex(0);
        setShowOutcome(false);
        setRecoveredAmount("");
      }
    } catch {
      // Silent
    }
    setSubmitting(false);
  }

  return (
    <div className="mb-4 p-4 bg-amber-50 border border-amber-200 rounded-xl">
      <div className="flex items-start justify-between mb-2">
        <div>
          <p className="text-sm font-semibold text-amber-900">
            {isFinal ? "Last reminder:" : ""} What happened with your dispute?
          </p>
          <p className="text-xs text-amber-700 mt-0.5">
            Your {typeLabel} for ${current.dispute.amount_disputed.toLocaleString()} was filed {daysAgo} days ago.
          </p>
        </div>
        {followups.length > 1 && (
          <span className="text-[10px] font-semibold text-amber-600 bg-amber-100 px-2 py-0.5 rounded-full shrink-0">
            {followups.length} pending
          </span>
        )}
      </div>

      {!showOutcome ? (
        <div className="flex flex-wrap gap-2 mt-3">
          <button
            onClick={() => setShowOutcome(true)}
            disabled={submitting}
            className="px-3 py-1.5 text-xs font-semibold text-white bg-green-600 rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50"
          >
            Won / Settled
          </button>
          <button
            onClick={() => handleAction("lost")}
            disabled={submitting}
            className="px-3 py-1.5 text-xs font-semibold text-red-700 border border-red-200 rounded-lg hover:bg-red-50 transition-colors disabled:opacity-50"
          >
            Lost / Denied
          </button>
          <button
            onClick={() => handleAction("still_waiting")}
            disabled={submitting}
            className="px-3 py-1.5 text-xs font-semibold text-amber-700 border border-amber-200 rounded-lg hover:bg-amber-100 transition-colors disabled:opacity-50"
          >
            Still Waiting
          </button>
          <button
            onClick={() => handleAction("dismiss")}
            disabled={submitting}
            className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 transition-colors disabled:opacity-50"
          >
            Dismiss
          </button>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2">
            <label className="text-xs text-amber-800">Amount recovered:</label>
            <span className="text-xs text-amber-600">$</span>
            <input
              type="number"
              value={recoveredAmount}
              onChange={(e) => setRecoveredAmount(e.target.value)}
              placeholder="0.00"
              className="w-28 px-2 py-1 text-sm border border-amber-300 rounded-lg bg-white"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => handleAction("won", parseFloat(recoveredAmount) || 0)}
              disabled={submitting}
              className="px-3 py-1.5 text-xs font-semibold text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-50"
            >
              Won
            </button>
            <button
              onClick={() => handleAction("settled", parseFloat(recoveredAmount) || 0)}
              disabled={submitting}
              className="px-3 py-1.5 text-xs font-semibold text-green-700 border border-green-200 rounded-lg hover:bg-green-50 disabled:opacity-50"
            >
              Settled
            </button>
            <button
              onClick={() => { setShowOutcome(false); setRecoveredAmount(""); }}
              className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700"
            >
              Back
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
