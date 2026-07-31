"use client";

/**
 * Bill card — per-bill summary card on `/claim` Bills tab.
 *
 * S138 (B4.2 design fidelity sweep): adopts design's tinted card chrome
 * (`billcard.flagged` warm amber bg + `billcard.review` orange bg) per
 * `/Users/andrewullmann/Downloads/styles.css` lines 237-321. This REVERSES
 * S131-FIX3 outline-only chrome per Andrew direction "execute the design".
 *
 * Originally B4.1 per design source-of-truth
 * `plans/findings/design-handoffs/s112-full-refresh/project/claim-summary.jsx`
 * (lines 52-170 BillCard + STATE_CONFIG):
 *   - 4-state STATE_CONFIG via shared `deriveBillState()` helper
 *     (overcharge_drafted / overcharge_no_draft / needs_review / clean)
 *   - Amounts diff block "You were billed → You should owe" with arrow + recovery delta
 *   - Narrative text below amounts for flagged/review states
 *   - Verbatim 4-state bottom-row copy per D-§1.D.1-G
 *   - "View full breakdown" footer action
 *
 * State is derived by the parent (page.tsx) and passed in as a prop so the
 * shared 4-state vocab lives in one place (`src/lib/claims/derive-bill-state.ts`).
 */

import type { BillState } from "@/lib/claims/derive-bill-state";
import type { SentLetterMeta } from "@/lib/claims/use-claim-pipeline";
import { cn } from "@/lib/utils/cn";

interface ClaimSummary {
  id: string;
  date_of_service: string | null;
  status: string;
  total_billed: number | null;
  total_patient_responsibility: number | null;
  // Session 86 / mig 092 — insurer's contractual write-off sum across line items.
  total_insurance_adjusted?: number | null;
  lineItemCount: number;
  findingCount: number;
  providerName: string;
  created_at: string;
  potentialSavings?: number;
  reviewNeededCount?: number;
  lineItemPatientOwedSum?: number;
  topFindings?: Array<{ title: string; estimatedOvercharge: number; billingCode?: string | null }>;
  recovery?: {
    billed: number;
    alreadyPaid: number;
    stillOutstanding: number;
    shouldOwe: number;
    potentialRecovery: number;
    refundComponent: number;
    forgivenessComponent: number;
  };
}

// 4-state STATE_CONFIG per design canvas lines 54-79 + styles.css lines 237-321.
// S138 (B4.2 design fidelity sweep): adopts design's tinted chrome —
//   - .billcard.flagged: bg #fffdf7 + border #fde68a (warm amber wash)
//   - .billcard.review : bg #fffaf3 + border #fed7aa (orange wash)
//   - .billcard.clean  : default white + gray border
// Status pills + amounts block follow the same state-tinted family so the
// card reads as a single chromatic unit. REVERSES S131-FIX3 outline-only ship.
const STATE_CONFIG: Record<
  BillState,
  {
    statusLabel: string;
    statusPillCls: string;
    statusDotCls: string;
    iconKey: "warn" | "search" | "check";
    iconCls: string;
    cardChromeCls: string;
    headerBorderCls: string;
    amountsBlockCls: string;
    footerBorderCls: string;
  }
> = {
  overcharge_drafted: {
    statusLabel: "Overcharge · dispute drafted",
    statusPillCls: "bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200",
    statusDotCls: "bg-amber-600",
    iconKey: "warn",
    iconCls: "bg-amber-100 text-amber-700",
    cardChromeCls: "border-amber-200 bg-[#fffdf7] hover:border-amber-300 hover:shadow-amber-100/40",
    headerBorderCls: "border-amber-100/70",
    amountsBlockCls: "bg-amber-50/70 border-amber-100",
    footerBorderCls: "border-amber-100/70",
  },
  overcharge_no_draft: {
    statusLabel: "Overcharge found",
    statusPillCls: "bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200",
    statusDotCls: "bg-amber-600",
    iconKey: "warn",
    iconCls: "bg-amber-100 text-amber-700",
    cardChromeCls: "border-amber-200 bg-[#fffdf7] hover:border-amber-300 hover:shadow-amber-100/40",
    headerBorderCls: "border-amber-100/70",
    amountsBlockCls: "bg-amber-50/70 border-amber-100",
    footerBorderCls: "border-amber-100/70",
  },
  needs_review: {
    statusLabel: "Needs review",
    statusPillCls: "bg-orange-50 text-orange-800 ring-1 ring-inset ring-orange-200",
    statusDotCls: "bg-orange-500",
    iconKey: "search",
    iconCls: "bg-orange-100 text-orange-700",
    cardChromeCls: "border-orange-200 bg-[#fffaf3] hover:border-orange-300 hover:shadow-orange-100/40",
    headerBorderCls: "border-orange-100/70",
    amountsBlockCls: "bg-orange-50/70 border-orange-100",
    footerBorderCls: "border-orange-100/70",
  },
  clean: {
    statusLabel: "Looks correct",
    statusPillCls: "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200",
    statusDotCls: "bg-emerald-500",
    iconKey: "check",
    iconCls: "bg-emerald-50 text-emerald-600",
    cardChromeCls: "border-gray-200 bg-white hover:border-blue-200 hover:shadow-blue-100/30",
    headerBorderCls: "border-gray-100",
    amountsBlockCls: "bg-gray-50 border-gray-100",
    footerBorderCls: "border-gray-100",
  },
};

function formatDate(iso: string | null): string {
  if (!iso) return "Date unknown";
  try {
    // F-6 — parse YYYY-MM-DD as a LOCAL calendar date, not a UTC instant.
    const match = iso.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) {
      const [, y, m, d] = match;
      return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    }
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function formatCurrency(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function StateIcon({ kind, className }: { kind: "warn" | "search" | "check" | "clock"; className?: string }) {
  if (kind === "clock") {
    return (
      <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 2m6-2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    );
  }
  if (kind === "warn") {
    return (
      <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 9v2m0 4h.01m-6.9 4h13.8c1.5 0 2.5-1.7 1.7-2.5L13.7 4c-.8-.8-2-.8-2.7 0L4.1 16.5c-.8.8.2 2.5 1.7 2.5z"
        />
      </svg>
    );
  }
  if (kind === "search") {
    return (
      <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
        />
      </svg>
    );
  }
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  );
}

function buildNarrative(state: BillState, claim: ClaimSummary, potentialRecovery: number, shouldOwe: number): string | null {
  if (state === "overcharge_drafted" || state === "overcharge_no_draft") {
    const recoveryLabel = potentialRecovery > 0 ? `$${formatCurrency(potentialRecovery)}` : "this amount";
    const shouldOweClause =
      shouldOwe > 0
        ? `Your plan says you shouldn't owe more than $${formatCurrency(shouldOwe)} for this bill`
        : `Your plan says you shouldn't owe anything for this bill`;
    return `${shouldOweClause} — the ${recoveryLabel} difference is recoverable.`;
  }
  if (state === "needs_review") {
    const reviewCount = claim.reviewNeededCount ?? 0;
    if (reviewCount > 0) {
      const lineWord = reviewCount === 1 ? "line item" : "line items";
      const verb = reviewCount === 1 ? "this service" : "these services";
      return `Your plan covers ${verb} but the EOB shows no per-line breakdown for ${reviewCount} ${lineWord}. Reconcile below.`;
    }
    return "Audit raised questions we need your input to resolve.";
  }
  return null;
}

function buildBottomRowCopy(state: BillState): { text: string; cls: string } {
  switch (state) {
    case "overcharge_drafted":
      // Drafted overcharge → blue affordance signal (Open dispute letter ready).
      return { text: "Dispute letter drafted", cls: "text-blue-700" };
    case "overcharge_no_draft":
      // Urgent overcharge → amber bolt icon copy.
      return { text: "Ready to draft dispute", cls: "text-amber-700" };
    case "needs_review":
      // Surface 2 copy per claim-summary.jsx (was "Questions for you").
      return { text: "Unclear from your plan", cls: "text-orange-700" };
    case "clean":
      return { text: "No issues found · plan matches bill", cls: "text-gray-600" };
  }
}

export function BillCard({
  claim,
  state,
  onSelect,
  reviewQuestionCount,
  guided = null,
}: {
  claim: ClaimSummary;
  state: BillState;
  onSelect: (claimId: string) => void;
  /** needs_review only — count for the "Answer N questions" button (page passes
   *  reviewNeededCount, falling back to that claim's open discrepancy count). */
  reviewQuestionCount?: number;
  /** Guided Steps v1 (S297, Andrew) — letter-lifecycle card treatment. Non-null
   *  = flag ON: no-letter → "Review +$X", drafted → "Send letter", sent →
   *  "Log response" on a WHITE card with the awaiting pill, re-ambering into a
   *  countdown as the response deadline approaches. Null → today's card,
   *  byte-identical. */
  guided?: { sentMeta: SentLetterMeta | null } | null;
}) {
  const config = STATE_CONFIG[state];
  // Sent-letter override: calm white chrome + awaiting pill; amber countdown
  // chrome returns when the window is near/past (his call is needed again).
  const sentMeta = state === "overcharge_drafted" ? (guided?.sentMeta ?? null) : null;
  const effConfig = sentMeta
    ? sentMeta.amber
      ? {
          ...config,
          statusLabel:
            sentMeta.daysRemaining != null && sentMeta.daysRemaining <= 0
              ? "Response window has passed"
              : `Response due in ${sentMeta.daysRemaining} ${sentMeta.daysRemaining === 1 ? "day" : "days"}`,
        }
      : {
          ...config,
          statusLabel: "Letter sent · awaiting response",
          statusPillCls: "bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-200",
          statusDotCls: "bg-blue-500",
          iconKey: "clock" as const,
          iconCls: "bg-blue-50 text-blue-600",
          cardChromeCls: STATE_CONFIG.clean.cardChromeCls,
          headerBorderCls: STATE_CONFIG.clean.headerBorderCls,
          amountsBlockCls: STATE_CONFIG.clean.amountsBlockCls,
          footerBorderCls: STATE_CONFIG.clean.footerBorderCls,
        }
    : config;
  const isFlagged = state === "overcharge_drafted" || state === "overcharge_no_draft";
  const isReview = state === "needs_review";
  const showAmountsBlock = isFlagged || isReview;

  const billed = claim.total_billed || 0;
  const insuranceAdjusted = Number(claim.total_insurance_adjusted ?? 0);
  const billedAdjusted = Math.max(0, billed - insuranceAdjusted);
  const shouldOwe = claim.recovery?.shouldOwe ?? claim.total_patient_responsibility ?? 0;
  const potentialRecovery =
    claim.recovery?.potentialRecovery ?? claim.potentialSavings ?? Math.max(0, billed - shouldOwe);
  const narrative = buildNarrative(state, claim, potentialRecovery, shouldOwe);
  const bottomRow = buildBottomRowCopy(state);

  // Surface 2 — big state-aware footer button. Labels are built as SINGLE text
  // nodes (a flex gap on the button would otherwise space out interpolated words).
  const questionCount = Math.max(1, reviewQuestionCount ?? claim.reviewNeededCount ?? 1);
  // Guided Steps v1 (S297, Andrew) — the button IS the letter's next action:
  // no letter → "Review +$X" · drafted → "Send letter" · sent → "Log response"
  // (verb unified with the followup banner). guided null → today's labels.
  const footerButton: { label: string; kind: "primary" | "amber"; icon?: "send" | "clock" } | null =
    state === "overcharge_drafted"
      ? guided
        ? sentMeta
          ? { label: "Log response", kind: sentMeta.amber ? "amber" : "primary", icon: "clock" }
          : { label: "Send letter", kind: "primary", icon: "send" }
        : { label: "Review & send letter", kind: "primary" }
      : state === "overcharge_no_draft"
        ? {
            label: guided
              ? `Review +$${formatCurrency(potentialRecovery)}`
              : `Review & recover +$${formatCurrency(potentialRecovery)}`,
            kind: "primary",
          }
        : state === "needs_review"
          ? {
              label: `Answer ${questionCount} ${questionCount === 1 ? "question" : "questions"}`,
              kind: "amber",
            }
          : null;

  return (
    <button
      type="button"
      onClick={() => onSelect(claim.id)}
      className={cn(
        "group block w-full overflow-hidden rounded-2xl border text-left transition-all hover:-translate-y-0.5 hover:shadow-md",
        effConfig.cardChromeCls,
      )}
    >
      {/* Header: icon + provider + date + status pill — bg inherits from card chrome */}
      <div
        className={cn(
          "flex items-start justify-between gap-3 border-b px-5 py-4",
          effConfig.headerBorderCls,
        )}
      >
        <div className="flex min-w-0 items-center gap-3">
          <div
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
              effConfig.iconCls,
            )}
          >
            <StateIcon kind={effConfig.iconKey} className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold leading-snug text-gray-900">{claim.providerName}</p>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-gray-500">
              <span>{formatDate(claim.date_of_service)}</span>
              <span className="h-[3px] w-[3px] rounded-full bg-gray-400" aria-hidden="true" />
              <span>
                {claim.lineItemCount} line {claim.lineItemCount === 1 ? "item" : "items"}
              </span>
              <span className="h-[3px] w-[3px] rounded-full bg-gray-400" aria-hidden="true" />
              <span>Total billed ${formatCurrency(billed)}</span>
            </div>
          </div>
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold",
            effConfig.statusPillCls,
          )}
        >
          <span className={cn("h-1.5 w-1.5 rounded-full", effConfig.statusDotCls)} />
          {effConfig.statusLabel}
        </span>
      </div>

      {/* Amounts diff block (flagged/review only) — state-tinted bg per design.
          Design: .billcard.flagged .billcard-amounts { background: #fffbeb; }
                  .billcard.review .billcard-amounts { background: #fff7ed; } */}
      {showAmountsBlock && (
        <div className="px-5 pt-4">
          <div
            className={cn(
              "flex items-center justify-between rounded-xl border px-4 py-3.5",
              effConfig.amountsBlockCls,
            )}
          >
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-gray-500">
                You were billed
              </p>
              <p className="mt-1 text-[24px] font-bold leading-none tabular-nums tracking-[-0.02em] text-gray-900">
                ${formatCurrency(billedAdjusted)}
              </p>
            </div>
            <svg
              className="h-5 w-5 shrink-0 text-gray-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 8l4 4m0 0l-4 4m4-4H3" />
            </svg>
            <div className="text-right">
              <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-gray-500">
                You should owe
              </p>
              {isReview ? (
                <p className="mt-1 text-[24px] font-bold leading-none tabular-nums text-orange-700">?</p>
              ) : (
                <p
                  className={cn(
                    "mt-1 text-[24px] font-bold leading-none tabular-nums tracking-[-0.02em]",
                    shouldOwe === 0 ? "text-emerald-600" : "text-gray-900",
                  )}
                >
                  ${formatCurrency(shouldOwe)}
                </p>
              )}
              {isFlagged && potentialRecovery > 0 && (
                <p className="mt-1 text-[11px] font-bold tabular-nums text-emerald-700">
                  ↑ +${formatCurrency(potentialRecovery)} recoverable
                </p>
              )}
              {isReview && (
                <p className="mt-1 text-[11px] font-semibold text-orange-700">
                  Unclear — review needed
                </p>
              )}
            </div>
          </div>
          {narrative && (
            <p
              className={cn(
                "mt-3 rounded-lg border-l-[3px] px-3.5 py-2.5 text-[13px] leading-relaxed",
                isReview
                  ? "border-orange-300 bg-orange-50/60 text-orange-900"
                  : "border-emerald-300 bg-emerald-50/60 text-emerald-900",
              )}
            >
              {narrative}
            </p>
          )}
        </div>
      )}

      {/* Findings preview — drafted/no-draft overcharge cards keep the existing
          top-N findings list for at-a-glance context. Stays warm amber to nest
          inside the flagged card. */}
      {isFlagged && claim.topFindings && claim.topFindings.length > 0 && (
        <div className="mx-5 mt-3 rounded-xl border border-amber-200/60 bg-white/50 p-3">
          <p className="text-xs font-semibold text-amber-900">
            We found {claim.findingCount} {claim.findingCount === 1 ? "issue" : "issues"} to dispute
          </p>
          <ul className="mt-2 space-y-1">
            {claim.topFindings.slice(0, 2).map((f, i) => (
              <li key={i} className="text-xs text-amber-800">
                <span className="mr-1.5 text-amber-600">•</span>
                {f.title}
                {f.billingCode && <span className="ml-1 text-amber-600">({f.billingCode})</span>}
                {f.estimatedOvercharge > 0 && (
                  <span className="ml-1 text-amber-900">— ~${f.estimatedOvercharge.toFixed(0)}</span>
                )}
              </li>
            ))}
            {claim.topFindings.length > 2 && (
              <li className="text-[11px] text-amber-700">+ {claim.topFindings.length - 2} more</li>
            )}
          </ul>
        </div>
      )}

      {/* Bottom row: state-specific copy + big state-aware action button
          (Surface 2). Clean bills keep the quiet "View full breakdown" link.
          Border inherits from card chrome family. */}
      <div
        className={cn(
          "mt-4 flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3",
          effConfig.footerBorderCls,
        )}
      >
        <span className={cn("text-xs font-semibold", bottomRow.cls)}>{bottomRow.text}</span>
        {footerButton ? (
          <span
            className={cn(
              "inline-flex w-full shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-[18px] py-2.5 text-[13px] font-semibold transition-all sm:w-auto",
              footerButton.kind === "primary" &&
                "bg-blue-600 text-white shadow-[0_0_20px_hsla(217,91%,60%,0.15),0_8px_32px_hsla(217,91%,60%,0.10)] group-hover:bg-blue-700 group-hover:shadow-[0_0_24px_hsla(217,91%,60%,0.25),0_12px_40px_hsla(217,91%,60%,0.15)]",
              footerButton.kind === "amber" &&
                "border border-amber-300 bg-amber-50 text-amber-800 group-hover:border-amber-400 group-hover:bg-amber-100",
            )}
          >
            {footerButton.label}
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24" aria-hidden="true">
              {footerButton.icon === "send" ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
              ) : footerButton.icon === "clock" ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 2m6-2a9 9 0 11-18 0 9 9 0 0118 0z" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M12 5l7 7-7 7" />
              )}
            </svg>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 transition-all group-hover:gap-1.5 group-hover:text-blue-700">
            View full breakdown
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </span>
        )}
      </div>
    </button>
  );
}
