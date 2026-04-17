"use client";

/**
 * Claim Preview Empty State — shown when user has 0 bills.
 *
 * Mirrors the Case/Care "Coming Soon" pattern: a focused centered card with the
 * primary CTA above a greyed-out sample dashboard showing what the page will
 * look like once populated. This sells the product by showing value before
 * asking for it.
 *
 * Difference from Case/Care: the CTA is active (not "coming soon") — Claim is live.
 */

import Link from "next/link";
import { BillCard } from "./BillCard";

// Fake sample data — greyed out — to illustrate what a populated Claim page looks like.
const SAMPLE_BILLS = [
  {
    id: "sample-1",
    date_of_service: "2026-04-15",
    status: "flagged",
    total_billed: 1847,
    total_patient_responsibility: 247,
    lineItemCount: 5,
    findingCount: 2,
    providerName: "Stanford Hospital",
    created_at: "2026-04-15",
    potentialSavings: 147,
    topFindings: [
      { title: "Office visit — copay mismatch", billingCode: "99213", estimatedOvercharge: 25 },
      { title: "Lab work — billed twice", billingCode: "85025", estimatedOvercharge: 122 },
    ],
  },
  {
    id: "sample-2",
    date_of_service: "2026-03-02",
    status: "processed",
    total_billed: 432,
    total_patient_responsibility: 30,
    lineItemCount: 2,
    findingCount: 0,
    providerName: "Palo Alto Medical Foundation",
    created_at: "2026-03-02",
  },
];

export function ClaimPreviewEmptyState() {
  return (
    <div className="relative">
      {/* Focused primary action — not "coming soon", this is live */}
      <div className="mb-6 rounded-2xl border border-blue-100 bg-gradient-to-br from-blue-50 via-white to-indigo-50 p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-white ring-1 ring-blue-100">
          <svg className="h-6 w-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
        </div>
        <h2 className="text-xl font-bold text-gray-900">See every overcharge. Fight every error.</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-gray-500">
          Upload an EOB or itemized bill. We break down every line, flag issues, and draft dispute letters.
        </p>
        <div className="mt-5 flex items-center justify-center gap-3">
          <Link
            href="/upload"
            className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700"
          >
            Upload your first bill
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
            </svg>
          </Link>
        </div>
      </div>

      {/* Preview label */}
      <div className="mb-3 flex items-center gap-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">
          Preview — this is what you&apos;ll see
        </p>
        <div className="h-px flex-1 bg-gray-100" />
      </div>

      {/* Greyed preview of sample bills */}
      <div className="pointer-events-none select-none space-y-3 opacity-50">
        {SAMPLE_BILLS.map((bill) => (
          <BillCard key={bill.id} claim={bill} onSelect={() => {}} />
        ))}

        {/* Sample discrepancy hint */}
        <div className="mt-4 rounded-2xl border border-gray-100 bg-white p-5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
            Discrepancy preview
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div className="rounded-lg bg-green-50 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-green-600">Expected</p>
              <p className="mt-0.5 text-sm font-semibold text-green-800">$30 copay</p>
              <p className="text-xs text-green-700">Per your plan</p>
            </div>
            <div className="rounded-lg bg-red-50 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-red-600">Actual</p>
              <p className="mt-0.5 text-sm font-semibold text-red-800">$147</p>
              <p className="text-xs text-red-700">What you were billed</p>
            </div>
          </div>
          <p className="mt-3 text-xs text-gray-500">
            When Candid finds a discrepancy, you&apos;ll see expected vs. actual with a one-click dispute letter.
          </p>
        </div>
      </div>
    </div>
  );
}
