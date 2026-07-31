"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth/auth-context";

/**
 * Followup banner — S81 dispute outcome reminders (30-day / 14-day / post-escalation).
 *
 * Phase 2 B4.1 refactor per design source-of-truth:
 *   plans/findings/design-handoffs/s117-followup-designs/batch-1-claim/batch-1.html
 *   (Item 1 of 5 — FollowupBanner position spec, Option A)
 *
 * Per Item 1 Option A:
 *   - Renders above the RecoveryHero on `/claim` (parent component placement)
 *   - Adopt design Banner chrome (warn tone): amber gradient + icon + typography
 *   - Dismissible per-banner via X close in top-right (calls existing dismiss API)
 *
 * Position:sticky to viewport is deliberately NOT applied — tab changes on `/claim`
 * don't scroll the page (tabs render inline within the same scroll context), so
 * the design intent ("survives tab changes") is satisfied by the existing render
 * placement above the tab body. Viewport-sticky positioning was reviewed and
 * deferred to avoid fighting the (app) layout sidebar positioning context.
 *
 * Action model preserved from prior implementation (4 outcomes:
 * Won/Settled / Lost/Denied / Still Waiting / X-dismiss) since it's more
 * functional than the design canvas's 2-button + X model.
 */

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
    // S297 (Andrew E2E #1) — which bill + deeplink target.
    claim_id?: string | null;
    provider_name?: string | null;
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
    <div className="mb-4 overflow-hidden rounded-2xl border border-amber-200 bg-gradient-to-b from-amber-50 to-white">
      <div className="flex items-start gap-3 px-4 py-3.5 sm:px-5 sm:py-4">
        {/* Icon */}
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-700 ring-1 ring-amber-200">
          <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 2m6-2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>

        {/* Meta + actions */}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-bold text-amber-900">
                {isFinal ? "Last reminder: " : ""}{daysAgo} days since you filed your {typeLabel}
              </p>
              <p className="mt-0.5 text-xs text-amber-800">
                {isFinal
                  ? "We won't ask again — please log the outcome so we can improve future disputes."
                  : `Did you get a response? Logging it helps us flag similar disputes for other users.`}
              </p>
              <p className="mt-0.5 text-[11px] text-amber-700/80">
                {/* S297 (Andrew E2E #1) — name the bill this response is for. */}
                {current.dispute.provider_name ? `${current.dispute.provider_name} · ` : ""}
                ${current.dispute.amount_disputed.toLocaleString()} disputed
                {followups.length > 1 && ` · ${followups.length} pending followups`}
              </p>
              <a
                href={`/disputes?dispute=${current.dispute.id}`}
                className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-amber-900 underline underline-offset-2 hover:text-amber-700"
              >
                Open dispute letter
                <span aria-hidden>→</span>
              </a>
            </div>

            {/* X dismiss — top-right, calls "dismiss" action */}
            <button
              type="button"
              onClick={() => handleAction("dismiss")}
              disabled={submitting}
              aria-label="Dismiss this followup"
              className="shrink-0 rounded-md p-1 text-amber-700/70 transition-colors hover:bg-amber-100 hover:text-amber-900 disabled:opacity-50"
            >
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>

          {/* Action row */}
          {!showOutcome ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={() => setShowOutcome(true)}
                disabled={submitting}
                className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-green-700 disabled:opacity-50"
              >
                Log response
              </button>
              <button
                onClick={() => handleAction("lost")}
                disabled={submitting}
                className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 transition-colors hover:bg-red-50 disabled:opacity-50"
              >
                Lost / Denied
              </button>
              <button
                onClick={() => handleAction("still_waiting")}
                disabled={submitting}
                className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-800 transition-colors hover:bg-amber-50 disabled:opacity-50"
              >
                Still waiting
              </button>
            </div>
          ) : (
            <div className="mt-3 space-y-2">
              <div className="flex items-center gap-2">
                <label className="text-xs font-medium text-amber-900">Amount recovered:</label>
                <span className="text-xs text-amber-700">$</span>
                <input
                  type="number"
                  value={recoveredAmount}
                  onChange={(e) => setRecoveredAmount(e.target.value)}
                  placeholder="0.00"
                  className="w-28 rounded-lg border border-amber-300 bg-white px-2 py-1 text-sm"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => handleAction("won", parseFloat(recoveredAmount) || 0)}
                  disabled={submitting}
                  className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-700 disabled:opacity-50"
                >
                  Won
                </button>
                <button
                  onClick={() => handleAction("settled", parseFloat(recoveredAmount) || 0)}
                  disabled={submitting}
                  className="rounded-lg border border-green-200 bg-white px-3 py-1.5 text-xs font-semibold text-green-700 hover:bg-green-50 disabled:opacity-50"
                >
                  Settled
                </button>
                <button
                  onClick={() => { setShowOutcome(false); setRecoveredAmount(""); }}
                  className="px-3 py-1.5 text-xs text-amber-700 hover:text-amber-900"
                >
                  Back
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
