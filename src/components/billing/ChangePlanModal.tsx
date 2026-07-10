"use client";
/**
 * Change plan — 3-tier picker (Free / Pro Monthly / Pro Annual).
 *
 * Pro-only entry point: opens from the active or cancels-on PlanCard.
 * Free users go through the existing `useSubscribeTrigger` flow which
 * subscribes at the monthly price; annual is reachable once on Pro.
 *
 * Behaviors per selection vs current cycle:
 *   - Same tier+cycle → "Already on this plan" (disabled CTA)
 *   - Cross-cycle (monthly↔annual) → POST /api/stripe/change-subscription
 *     with targetCycle; Stripe handles proration.
 *   - Free (downgrade) → close this modal + caller opens CancelModal so the
 *     cancel-reason flywheel signal still gets captured.
 */

import { useEffect, useState } from "react";
import { ModalShell } from "@/components/modal";
import { useAuth } from "@/lib/auth/auth-context";
import type { TierCycle } from "@/lib/subscription/use-subscription";

interface ChangePlanModalProps {
  open: boolean;
  currentCycle: TierCycle;
  onClose: () => void;
  /** Called after a successful cycle switch — caller refreshes subscription state. */
  onChanged: () => Promise<void> | void;
  /** Called when the user picks "Free" — caller closes this modal and opens CancelModal. */
  onDowngradeToFree: () => void;
}

type Choice = "free" | "monthly" | "annual";

interface TierOption {
  id: Choice;
  name: string;
  price: string;
  cycle: string;
  blurb: string;
  perks: string[];
  saveBadge?: string;
}

const TIERS: TierOption[] = [
  {
    id: "free",
    name: "Free",
    price: "$0",
    cycle: "forever",
    blurb: "Audit one bill at a time. See findings, no dispute drafting.",
    perks: ["Audit 1 bill / month", "Plan benefits page", "Compare up to 3 plans"],
  },
  {
    id: "monthly",
    name: "Candid Pro",
    price: "$5",
    cycle: "month",
    blurb: "Unlimited audits, dispute letters, and bundled appeals.",
    perks: [
      "Unlimited bill audits",
      "Unlimited dispute letters",
      "Bundle multiple bills",
      "Priority support",
    ],
  },
  {
    id: "annual",
    name: "Pro · Annual",
    price: "$48",
    cycle: "year",
    blurb: "Same as Pro, billed yearly. Two months free.",
    perks: ["Everything in Pro", "$48/yr vs $60/yr", "Two months free", "Cancel anytime"],
    saveBadge: "Save $12",
  },
];

export function ChangePlanModal({
  open,
  currentCycle,
  onClose,
  onChanged,
  onDowngradeToFree,
}: ChangePlanModalProps) {
  const { user } = useAuth();
  const [picked, setPicked] = useState<Choice>(currentCycle);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPicked(currentCycle);
      setSubmitting(false);
      setError(null);
    }
  }, [open, currentCycle]);

  const isCurrent = picked === currentCycle;
  const isDowngradeToFree = picked === "free";
  const isCycleSwitch = picked !== "free" && picked !== currentCycle;

  async function handleConfirm() {
    if (!user || submitting) return;

    if (isCurrent) return; // disabled
    if (isDowngradeToFree) {
      onDowngradeToFree();
      return;
    }

    if (!isCycleSwitch) return;

    setSubmitting(true);
    setError(null);
    try {
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/stripe/change-subscription", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ targetCycle: picked }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Plan change failed");
      }
      await onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Plan change failed");
    } finally {
      setSubmitting(false);
    }
  }

  const confirmLabel = (() => {
    if (isCurrent) return "Already on this plan";
    if (isDowngradeToFree) return "Downgrade to Free";
    if (picked === "annual") return submitting ? "Switching…" : "Switch to annual";
    if (picked === "monthly") return submitting ? "Switching…" : "Switch to monthly";
    return "Confirm";
  })();

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      tone="default"
      size="lg"
      eyebrow="Pick what fits"
      title="Change your plan"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2.5 text-[14px] font-semibold text-gray-700 hover:bg-gray-100 rounded-xl transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isCurrent || submitting}
            className={`px-4 py-2.5 text-[14px] font-semibold text-white rounded-xl transition-colors disabled:cursor-not-allowed ${
              isDowngradeToFree
                ? "bg-red-600 hover:bg-red-700 disabled:bg-red-300"
                : "bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300"
            }`}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="space-y-2">
        {TIERS.map((t) => {
          const isPicked = picked === t.id;
          const isTierCurrent = t.id === currentCycle;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setPicked(t.id)}
              className={`w-full rounded-xl border p-3.5 text-left transition-colors ${
                isPicked
                  ? "border-blue-300 bg-blue-50/40"
                  : "border-gray-200 bg-white hover:border-gray-300"
              }`}
            >
              <div className="flex items-center gap-3">
                <span
                  className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border-2 ${
                    isPicked ? "border-blue-600" : "border-gray-300"
                  }`}
                >
                  {isPicked && (
                    <svg
                      className="h-2.5 w-2.5 text-blue-600"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-gray-900">{t.name}</span>
                    {isTierCurrent && (
                      <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">
                        Current
                      </span>
                    )}
                    {t.saveBadge && (
                      <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                        {t.saveBadge}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-gray-600">{t.blurb}</div>
                </div>
                <div className="text-right">
                  <div className="text-lg font-bold text-gray-900 leading-none">
                    {t.price}
                  </div>
                  <div className="text-[11px] text-gray-500">/ {t.cycle}</div>
                </div>
              </div>
              <ul className="mt-3 ml-7 grid grid-cols-2 gap-x-3 gap-y-1">
                {t.perks.map((p) => (
                  <li
                    key={p}
                    className="flex items-start gap-1.5 text-[12px] text-gray-700"
                  >
                    <svg
                      className="mt-0.5 h-3 w-3 flex-shrink-0 text-emerald-600"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                    {p}
                  </li>
                ))}
              </ul>
            </button>
          );
        })}
      </div>
      {isDowngradeToFree && (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900">
          <strong>Heads up:</strong> your current dispute drafts stay, but you
          won&apos;t be able to draft new ones on Free. You can re-upgrade
          anytime. We&apos;ll ask why before finalizing.
        </div>
      )}
      {isCycleSwitch && currentCycle === "annual" && picked === "monthly" && (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900">
          <strong>Heads up:</strong> you already paid for the year. We apply that
          payment to your monthly fee, so you won&apos;t be charged monthly for a
          while.
        </div>
      )}
      {isCycleSwitch && currentCycle === "monthly" && picked === "annual" && (
        <div className="mt-3 rounded-xl border border-blue-100 bg-blue-50 p-2.5 text-xs text-blue-900">
          <strong>Heads up:</strong> we&apos;ll bill the prorated difference today
          and lock in a full year of Pro — $12 cheaper than monthly. Switch back
          anytime.
        </div>
      )}
      {error && (
        <p className="mt-3 rounded-lg border border-red-100 bg-red-50 p-2 text-xs text-red-700">
          {error}
        </p>
      )}
    </ModalShell>
  );
}
