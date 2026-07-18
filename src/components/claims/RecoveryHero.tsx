"use client";

import { cn } from "@/lib/utils/cn";

/**
 * Recovery hero — top-of-page hero on `/claim` summarizing potential recovery
 * across the user's audited bills.
 *
 * Clarity redesign Surface 2 (design_handoff_clarity_redesign README §2 +
 * claim-summary.jsx RecoveryHero): the S138 4-stat row + top-right CTA are
 * replaced by the "Your next steps" strip — three CLICKABLE stat tiles
 * (flagged / awaiting input / letters ready) that set the matching bill-list
 * filter below and scroll to it. Context copy ends "Complete the steps below
 * to get started."
 *
 * Tiles: white card, border, hover lift; 30px count; pill action button that
 * fills solid on hover; active tile stays highlighted. Tone: amber for
 * needs-input (when >0), blue for letters-ready.
 */

export interface RecoveryHeroStats {
  /** Total $ recoverable across all bills (T2.8 framing). */
  totalRecovery: number;
  /** Total bills audited. */
  billsCount: number;
  /** Confirmed overcharge count (drafted or not). */
  issuesCount: number;
  /** Drafted-dispute count. */
  disputesCount: number;
  /** Bills with review-needed state (unclear from plan). */
  reviewCount: number;
}

/** The three next-step list filters (matches /claim tab ids minus "bills"). */
export type NextStepView = "flagged" | "input" | "letters";

interface RecoveryHeroProps {
  stats: RecoveryHeroStats;
  variant?: "calm" | "ink";
  /** Currently-active list filter (null when the unfiltered All-bills tab is shown). */
  activeView?: NextStepView | null;
  /** Tile click → set the matching list filter + scroll to the list. */
  onStep?: (view: NextStepView) => void;
}

function formatCurrency(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function RecoveryHero({
  stats,
  variant = "calm",
  activeView = null,
  onStep,
}: RecoveryHeroProps) {
  const { totalRecovery, billsCount, issuesCount, disputesCount, reviewCount } = stats;
  const isCalm = variant === "calm";

  const steps: Array<{
    id: NextStepView;
    count: number;
    tone: "flag" | "attn" | "ready" | "none";
    label: string;
    verb: string;
  }> = [
    {
      id: "flagged",
      count: issuesCount,
      tone: "flag",
      label: issuesCount === 1 ? "Bill flagged for review" : "Bills flagged for review",
      verb: "Review them",
    },
    {
      id: "input",
      count: reviewCount,
      tone: reviewCount > 0 ? "attn" : "none",
      label: reviewCount === 1 ? "Bill awaiting your input" : "Bills awaiting your input",
      verb: "Answer now",
    },
    {
      id: "letters",
      count: disputesCount,
      tone: disputesCount > 0 ? "ready" : "none",
      label: disputesCount === 1 ? "Dispute ready to send" : "Disputes ready to send",
      verb: "Open letters",
    },
  ];

  return (
    <div
      className={cn(
        "relative mb-6 overflow-hidden rounded-3xl border border-gray-200 bg-white",
        "px-6 py-7 shadow-[0_1px_2px_rgba(15,23,42,0.03),0_12px_32px_-16px_rgba(15,23,42,0.08)] sm:px-8 sm:py-8",
      )}
    >
      {/* Left rail accent — calm variant only. Design: 4px blue gradient. */}
      {isCalm && (
        <div
          className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-blue-500 to-blue-700"
          aria-hidden="true"
        />
      )}

      <div className={cn("relative", isCalm && "pl-3")}>
        {/* Head: eyebrow + bigfig + context */}
        <div className="min-w-0">
          <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-blue-600">
            Potential recovery
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span
              className="font-bold text-emerald-600"
              style={{ fontSize: "clamp(24px, 3.5vw, 38px)", lineHeight: 1 }}
            >
              ↑
            </span>
            <span
              className="font-bold tracking-[-0.035em] text-gray-900 tabular-nums"
              style={{ fontSize: "clamp(48px, 7vw, 76px)", lineHeight: 1 }}
            >
              ${formatCurrency(totalRecovery)}
            </span>
          </div>
          <p className="mt-2.5 max-w-[66ch] text-sm leading-[1.55] text-gray-600">
            Across {billsCount} {billsCount === 1 ? "bill" : "bills"} you uploaded, Candid found{" "}
            <strong className="font-semibold text-gray-900">
              ${formatCurrency(totalRecovery)} you can recover
            </strong>
            . Complete the steps below to get started.
          </p>
        </div>

        {/* "Your next steps" strip — 3 clickable tiles that filter the list below. */}
        <div className="mt-5 border-t border-gray-100 pt-4">
          <div className="mb-2.5 text-[10.5px] font-bold uppercase tracking-[0.1em] text-gray-400">
            Your next steps
          </div>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
            {steps.map((s) => {
              const isActive = activeView === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onStep?.(s.id)}
                  className={cn(
                    "group flex flex-col items-center gap-1.5 rounded-[14px] border bg-white px-3.5 pb-3.5 pt-4 text-center transition-all",
                    "hover:-translate-y-px hover:border-blue-300 hover:shadow-[0_4px_14px_-6px_rgba(37,99,235,0.18)]",
                    isActive ? "border-blue-400 bg-blue-50" : "border-gray-200",
                  )}
                >
                  {/* Count color per Andrew review: >0 = candid red (needs
                      handling), 0 = green (nothing to handle). */}
                  <span
                    className={cn(
                      "text-[30px] font-bold leading-none tracking-[-0.02em] tabular-nums",
                      s.count > 0 ? "text-red-600" : "text-green-600",
                    )}
                  >
                    {s.count}
                  </span>
                  <span className="text-[13px] font-semibold leading-[1.3] text-gray-700">
                    {s.label}
                  </span>
                  <span
                    className={cn(
                      "mt-1 inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[12.5px] font-semibold transition-all group-hover:gap-1.5",
                      s.tone === "attn"
                        ? cn(
                            "bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-300",
                            "group-hover:bg-amber-600 group-hover:text-white group-hover:ring-0",
                            isActive && "bg-amber-600 text-white ring-0",
                          )
                        : cn(
                            "bg-blue-50 text-blue-600 ring-1 ring-inset ring-blue-200",
                            "group-hover:bg-blue-600 group-hover:text-white group-hover:ring-0",
                            isActive && "bg-blue-600 text-white ring-0",
                          ),
                    )}
                  >
                    {s.verb}
                    <svg
                      className="h-3 w-3"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M5 12h14M12 5l7 7-7 7" />
                    </svg>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
