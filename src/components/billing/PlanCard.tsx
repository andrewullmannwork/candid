"use client";
/**
 * Plan card — 4 variants (active / cancels_on / past_due / free).
 *
 * Variant derived from useSubscription state:
 *   - status === 'past_due'  → past_due (rose; warning alert + retry log + 3-button action row)
 *   - cancelAtPeriodEnd      → cancels_on (amber; Resume + Change plan)
 *   - isPro                  → active (default; Change plan + Cancel)
 *   - else                   → free (Upgrade to Pro)
 *
 * Callbacks delegate state mutations to /billing/page.tsx so the card stays
 * a pure view layer.
 */

import { PastDueRetryLog } from "./PastDueRetryLog";
import type { PastDueRetryEvent, TierCycle } from "@/lib/subscription/use-subscription";
import { cn } from "@/lib/utils/cn";

// The dispute-letters perk flips with dispute_letters_free_start_v1: when
// free-to-start is ON, letters aren't a Pro perk — escalation is.
function proPerks(disputeLettersFree: boolean): string[] {
  return [
    "Unlimited bill audits",
    disputeLettersFree
      ? "Escalation letters — final notice + external review"
      : "Unlimited dispute letters",
    "Bundle multiple bills into one appeal",
    "Priority support · ~24 hour reply",
    "Case file export when Case launches",
  ];
}

interface PlanCardProps {
  tier: "free" | "pro";
  status: "none" | "trialing" | "active" | "canceled" | "past_due";
  tierCycle: TierCycle;
  cancelAtPeriodEnd: boolean;
  periodEnd: string | null;
  pastDueRetryLog: PastDueRetryEvent[] | null;
  onUpgrade: () => void;
  onChangePlan: () => void;
  onCancel: () => void;
  onResume: () => void;
  onUpdateCard: () => void;
  resumeSubmitting?: boolean;
  upgradeDisabled?: boolean;
  /** dispute_letters_free_start_v1 — flips the dispute-letters perk copy. */
  disputeLettersFree?: boolean;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 4v6h6M20 20v-6h-6M4 10a8 8 0 0114-2M20 14a8 8 0 01-14 2" />
    </svg>
  );
}

function WarningIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 9v2m0 4h.01m-6.9 4h13.8c1.5 0 2.5-1.7 1.7-2.5L13.7 4c-.8-.8-2-.8-2.7 0L4.1 16.5c-.8.8.2 2.5 1.7 2.5z" />
    </svg>
  );
}

function PlanPriceBlock({ tierCycle }: { tierCycle: TierCycle }) {
  const amount = tierCycle === "annual" ? "$48" : "$5";
  const cycle = tierCycle === "annual" ? "year" : "month";
  return (
    <div className="mt-2 flex items-baseline gap-1.5">
      <span className="text-3xl font-bold text-gray-900">{amount}</span>
      <span className="text-sm text-gray-500">/ {cycle}</span>
    </div>
  );
}

function PerksList({
  tone = "default",
  disputeLettersFree = false,
}: {
  tone?: "default" | "muted";
  disputeLettersFree?: boolean;
}) {
  return (
    <ul className="mt-4 space-y-2">
      {proPerks(disputeLettersFree).map((p) => (
        <li
          key={p}
          className={cn(
            "flex items-start gap-2 text-sm",
            tone === "muted" ? "text-gray-500" : "text-gray-700",
          )}
        >
          <CheckIcon
            className={cn(
              "mt-0.5 h-3.5 w-3.5 flex-shrink-0",
              tone === "muted" ? "text-gray-400" : "text-emerald-600",
            )}
          />
          <span>{p}</span>
        </li>
      ))}
    </ul>
  );
}

export function PlanCard(props: PlanCardProps) {
  const {
    tier,
    status,
    tierCycle,
    cancelAtPeriodEnd,
    periodEnd,
    pastDueRetryLog,
    onUpgrade,
    onChangePlan,
    onCancel,
    onResume,
    onUpdateCard,
    resumeSubmitting,
    upgradeDisabled,
    disputeLettersFree = false,
  } = props;

  // ── Past-due variant ────────────────────────────────────────────────
  if (status === "past_due") {
    return (
      <div className="rounded-2xl border border-rose-200 bg-rose-50/40 p-5">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.15em] text-rose-700">
              Current plan · past due
            </div>
            <div className="mt-1 text-lg font-bold text-gray-900">Candid Pro</div>
          </div>
          <span className="flex items-center gap-1.5 rounded-full bg-rose-100 px-2.5 py-1 text-[11px] font-semibold text-rose-800">
            <span className="h-1.5 w-1.5 rounded-full bg-rose-600" />
            Past due
          </span>
        </div>

        <div className="mt-4 flex gap-2.5 rounded-xl border border-rose-200 bg-white p-3">
          <WarningIcon className="mt-0.5 h-4 w-4 flex-shrink-0 text-rose-700" />
          <div>
            <div className="text-sm font-semibold text-gray-900">
              Your card was declined.
            </div>
            <div className="mt-1 text-xs text-gray-600">
              We&apos;ll keep trying for the next 14 days. If we still can&apos;t
              charge after that, your plan will drop to <strong>Free</strong>{" "}
              automatically. Update your card now to keep Pro features active.
            </div>
          </div>
        </div>

        {pastDueRetryLog && pastDueRetryLog.length > 0 && (
          <div className="mt-3">
            <PastDueRetryLog events={pastDueRetryLog} />
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onUpdateCard}
            className="flex-1 rounded-xl bg-red-600 px-3 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-700"
          >
            Update card now
          </button>
          <button
            type="button"
            onClick={onUpdateCard}
            className="rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
          >
            Use a different card
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl px-3 py-2.5 text-sm font-medium text-red-700 transition-colors hover:bg-red-50"
          >
            Cancel subscription
          </button>
        </div>
      </div>
    );
  }

  // ── Cancels-on variant ──────────────────────────────────────────────
  if (tier === "pro" && cancelAtPeriodEnd) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50/40 p-5">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.15em] text-amber-700">
              Cancels on
            </div>
            <div className="mt-1 text-lg font-bold text-gray-900">Candid Pro</div>
          </div>
          <span className="flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-semibold text-amber-800">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-600" />
            Cancels {formatDate(periodEnd)}
          </span>
        </div>

        <PlanPriceBlock tierCycle={tierCycle} />

        <div className="mt-1.5 flex items-center gap-1.5 text-xs text-gray-600">
          <RefreshIcon className="h-3 w-3" />
          You keep Pro until {formatDate(periodEnd)}, then drop to Free.
        </div>

        <PerksList tone="muted" disputeLettersFree={disputeLettersFree} />

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onResume}
            disabled={resumeSubmitting}
            className="flex-1 rounded-xl bg-blue-600 px-3 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
          >
            {resumeSubmitting ? "Keeping…" : "Keep my subscription"}
          </button>
          <button
            type="button"
            onClick={onChangePlan}
            className="rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
          >
            Change plan
          </button>
        </div>
      </div>
    );
  }

  // ── Active Pro variant ──────────────────────────────────────────────
  if (tier === "pro") {
    return (
      <div className="rounded-2xl border border-gray-100 bg-white p-5">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.15em] text-gray-500">
              Current plan
            </div>
            <div className="mt-1 text-lg font-bold text-gray-900">Candid Pro</div>
          </div>
          <span className="flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-semibold text-emerald-800">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-600" />
            Active
          </span>
        </div>

        <PlanPriceBlock tierCycle={tierCycle} />

        <div className="mt-1.5 flex items-center gap-1.5 text-xs text-gray-500">
          <RefreshIcon className="h-3 w-3" />
          Renews {formatDate(periodEnd)}
        </div>

        <PerksList disputeLettersFree={disputeLettersFree} />

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onChangePlan}
            className="flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
          >
            Change plan
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl px-3 py-2.5 text-sm font-medium text-gray-600 transition-colors hover:bg-red-50 hover:text-red-700"
          >
            Cancel subscription
          </button>
        </div>
      </div>
    );
  }

  // ── Free variant ────────────────────────────────────────────────────
  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-5">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.15em] text-gray-500">
            Current plan
          </div>
          <div className="mt-1 text-lg font-bold text-gray-900">Candid Free</div>
        </div>
        <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-semibold text-gray-700">
          Free
        </span>
      </div>

      <p className="mt-3 text-sm text-gray-600">
        Audit one bill at a time. See findings, but no dispute drafting.
      </p>

      <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50/50 p-3">
        <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-blue-700">
          Unlock with Pro
        </div>
        <ul className="mt-2 space-y-1.5">
          {proPerks(disputeLettersFree).slice(0, 3).map((p) => (
            <li key={p} className="flex items-start gap-1.5 text-xs text-blue-900">
              <CheckIcon className="mt-0.5 h-3 w-3 flex-shrink-0 text-blue-600" />
              <span>{p}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-4">
        <button
          type="button"
          onClick={onUpgrade}
          disabled={upgradeDisabled}
          className="w-full rounded-xl bg-blue-600 px-3 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
        >
          {upgradeDisabled ? "Opening…" : "Upgrade to Pro"}
        </button>
      </div>
    </div>
  );
}
