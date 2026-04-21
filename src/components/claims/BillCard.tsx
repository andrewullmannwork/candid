"use client";

/**
 * Bill Card — rich, Airbnb-trip-card-style card for each bill on the Claim page.
 *
 * Replaces the simple row-style ClaimsList. Each card surfaces the "aha" moment:
 * what the provider billed, what you owe, what's wrong, and how much you could save.
 * Click to open the full ClaimDetail line-item breakdown.
 */

interface ClaimSummary {
  id: string;
  date_of_service: string | null;
  status: string;
  total_billed: number | null;
  total_patient_responsibility: number | null;
  lineItemCount: number;
  findingCount: number;
  providerName: string;
  created_at: string;
  // Optional extended fields (from API enrichment)
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

const STATUS: Record<string, { label: string; className: string; dotClass: string }> = {
  processed: {
    label: "Clean",
    className: "text-green-700 bg-green-50 border-green-100",
    dotClass: "bg-green-500",
  },
  flagged: {
    label: "Issues found",
    className: "text-amber-700 bg-amber-50 border-amber-100",
    dotClass: "bg-amber-500",
  },
  pending: {
    label: "Processing",
    className: "text-blue-700 bg-blue-50 border-blue-100",
    dotClass: "bg-blue-500",
  },
  denied: {
    label: "Denied",
    className: "text-red-700 bg-red-50 border-red-100",
    dotClass: "bg-red-500",
  },
  appealed: {
    label: "Appealed",
    className: "text-purple-700 bg-purple-50 border-purple-100",
    dotClass: "bg-purple-500",
  },
  // Synthetic status for client-side override when review is needed
  needs_review: {
    label: "Needs review",
    className: "text-amber-700 bg-amber-50 border-amber-100",
    dotClass: "bg-amber-500",
  },
  // Synthetic status when plan says you shouldn't owe but the bill charges
  // you anyway — a recoverable overcharge (Session 35 T2.8).
  overcharge_found: {
    label: "Overcharge found",
    className: "text-amber-700 bg-amber-50 border-amber-100",
    dotClass: "bg-amber-500",
  },
};

function formatDate(iso: string | null): string {
  if (!iso) return "Date unknown";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

export function BillCard({
  claim,
  onSelect,
}: {
  claim: ClaimSummary;
  onSelect: (claimId: string) => void;
}) {
  const hasIssues = claim.findingCount > 0;
  const reviewCount = claim.reviewNeededCount || 0;
  const savings = claim.potentialSavings || 0;
  const billed = claim.total_billed || 0;
  const providerClaimedOwed = claim.total_patient_responsibility || 0;
  // Prefer API-derived recovery figures (T2.8). Fall back to the old
  // heuristic for legacy cached payloads before Session 35 rollout.
  const shouldOwe = claim.recovery?.shouldOwe ?? (reviewCount > 0 ? 0 : providerClaimedOwed);
  const potentialRecovery = claim.recovery?.potentialRecovery ?? Math.max(0, billed - shouldOwe);
  // Synthetic status precedence (most severe wins):
  //   1. Classic audit findings  → claim.status (typically "flagged")
  //   2. Unverified-charge review → "needs_review"
  //   3. Plan-vs-bill overcharge → "overcharge_found" (new — replaces the
  //      misleading "Clean" badge when there's a clear recovery opportunity)
  //   4. Everything else         → claim.status
  const effectiveStatus = hasIssues
    ? claim.status
    : reviewCount > 0
      ? "needs_review"
      : potentialRecovery > 0
        ? "overcharge_found"
        : claim.status;
  const status = STATUS[effectiveStatus] || STATUS.processed;

  return (
    <button
      onClick={() => onSelect(claim.id)}
      className={`group block w-full overflow-hidden rounded-2xl border bg-white text-left transition-all hover:-translate-y-0.5 hover:shadow-md ${
        potentialRecovery > 0
          ? "border-green-200 hover:border-green-300 ring-1 ring-green-100"
          : "border-gray-100 hover:border-blue-200"
      }`}
    >
      {/* Header: provider + date + status badge */}
      <div className="flex items-start justify-between gap-3 border-b border-gray-50 bg-gray-50/50 px-5 py-3.5">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white text-gray-500 ring-1 ring-gray-200">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
            </svg>
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-gray-900">{claim.providerName}</p>
            <p className="text-xs text-gray-500">{formatDate(claim.date_of_service)}</p>
          </div>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${status.className}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${status.dotClass}`} />
          {status.label}
        </span>
      </div>

      {/* Body: amounts */}
      <div className="px-5 py-4">
        {/* Main row: BILLED → YOU SHOULD OWE. Both columns kept equal height so
            labels align on the top edge, numbers align on the bottom edge, and
            the arrow sits visually centered between them. The recovery tagline
            is moved to a separate row below so it doesn't shift the arrow. */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-gray-400">Billed</p>
            <p className="mt-0.5 text-xl font-bold text-gray-900 tabular-nums">
              ${billed.toLocaleString()}
            </p>
          </div>
          <svg className="h-5 w-5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 8l4 4m0 0l-4 4m4-4H3" />
          </svg>
          <div className="text-right">
            <p className="text-[11px] font-medium uppercase tracking-wider text-gray-400">You should owe</p>
            <p
              className={`mt-0.5 text-xl font-bold tabular-nums ${
                shouldOwe === 0 ? "text-green-600" : "text-gray-900"
              }`}
            >
              ${shouldOwe.toLocaleString()}
            </p>
          </div>
        </div>
        {potentialRecovery > 0 && (
          <p className="mt-1.5 text-right text-[11px] font-bold text-green-700 tabular-nums">
            +${potentialRecovery.toLocaleString()} recovery
          </p>
        )}

        {/* Findings preview */}
        {hasIssues && claim.topFindings && claim.topFindings.length > 0 && (
          <div className="mt-4 rounded-xl border border-amber-100 bg-amber-50/60 p-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-amber-900">
                {claim.findingCount} {claim.findingCount === 1 ? "issue" : "issues"} found
              </p>
              {savings > 0 && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-800 tabular-nums">
                  ~${savings.toLocaleString()} savings
                </span>
              )}
            </div>
            <ul className="mt-2 space-y-1">
              {claim.topFindings.slice(0, 2).map((f, i) => (
                <li key={i} className="text-xs text-amber-800">
                  <span className="mr-1.5 text-amber-600">•</span>
                  {f.title}
                  {f.billingCode && (
                    <span className="ml-1 text-amber-600">({f.billingCode})</span>
                  )}
                  {f.estimatedOvercharge > 0 && (
                    <span className="ml-1 text-amber-900">— ~${f.estimatedOvercharge.toFixed(0)}</span>
                  )}
                </li>
              ))}
              {claim.topFindings.length > 2 && (
                <li className="text-[11px] text-amber-700">
                  + {claim.topFindings.length - 2} more
                </li>
              )}
            </ul>
          </div>
        )}

        {!hasIssues && reviewCount > 0 && (
          <div className="mt-4 rounded-xl border border-amber-100 bg-amber-50/60 p-3">
            <p className="text-xs font-semibold text-amber-900">
              {buildReviewHeadline(reviewCount)}
            </p>
            <p className="mt-1 text-xs text-amber-800">
              {buildReviewExplanation(reviewCount)}
            </p>
          </div>
        )}

        {/* Potential recovery callout — user shouldn't owe this much per plan.
            Precedence: audit findings > unverified charges > recovery
            opportunity > clean. Recovery branch fires only when the other
            two are quiet, so we don't stack redundant callouts. */}
        {!hasIssues && reviewCount === 0 && potentialRecovery > 0 && (
          <div className="mt-4 rounded-xl border border-green-100 bg-green-50/60 p-3">
            <p className="text-xs font-semibold text-green-900">
              Potential recovery: +${potentialRecovery.toLocaleString()}
            </p>
            <p className="mt-1 text-xs text-green-800">
              Your plan says you shouldn&apos;t owe{shouldOwe > 0 ? ` more than $${shouldOwe.toLocaleString()}` : " anything"} for this bill. The difference is recoverable — consider disputing.
            </p>
          </div>
        )}

        {!hasIssues && reviewCount === 0 && potentialRecovery === 0 && (
          <div className="mt-4 rounded-xl border border-green-100 bg-green-50/60 p-3">
            <p className="text-xs font-semibold text-green-900">
              No billing errors detected · {claim.lineItemCount} line {claim.lineItemCount === 1 ? "item" : "items"} audited
            </p>
          </div>
        )}

        {/* Footer CTA */}
        <div className="mt-4 flex items-center justify-between">
          <p className="text-xs text-gray-500">
            {claim.lineItemCount} line {claim.lineItemCount === 1 ? "item" : "items"}
          </p>
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 transition-colors group-hover:text-blue-700">
            View full breakdown
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </span>
        </div>
      </div>
    </button>
  );
}

// ── Copy templates for the "needs review" callout ──────────────────────────
//
// Builders assemble the headline and explanation from independently optional
// fragments. Any missing value causes its sentence (or sub-clause) to be
// omitted entirely — no "undefined" artifacts, no awkward punctuation.

function buildReviewHeadline(reviewCount: number): string {
  const plural = reviewCount === 1 ? "line item" : "line items";
  return `${reviewCount} covered ${plural} with unverified charges`;
}

function buildReviewExplanation(reviewCount: number): string {
  const serviceRef = reviewCount === 1 ? "this service" : "these services";
  return `Your plan covers ${serviceRef}, but the EOB shows no line-item breakdown. See the full breakdown below to reconcile what's already been paid vs. what you still owe.`;
}
