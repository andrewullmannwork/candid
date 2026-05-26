"use client";

/**
 * Claim Preview Empty State — shown when user has 0 bills.
 *
 * Phase 2 B4.1 — design source-of-truth:
 *   plans/findings/design-handoffs/s117-followup-designs/batch-1-claim/batch-1.html
 *   (Item 2 of 5 — ClaimPreviewEmptyState first-time-user surface, lines 137-189)
 *
 * Per Item 2 render rule: when `bills.length === 0`, this component replaces
 * the entire claim body (hero + tabs hidden). The sidebar nav stays unchanged.
 *
 * Adds the 3-step "HOW IT WORKS" explainer (Upload / Audit / Recover) per the
 * Round 2 design canvas, while preserving the existing greyed sample preview
 * (load-bearing value-before-asking pattern). The "See a sample audit"
 * secondary CTA is intentionally DROPPED for B4.1 — flagged back to design
 * for destination spec before re-introduction.
 */

import Link from "next/link";
import { BillCard } from "./BillCard";
import type { BillState } from "@/lib/claims/derive-bill-state";

// Fake sample data — greyed out — to illustrate what a populated Claim page looks like.
const SAMPLE_BILLS: Array<{ bill: Parameters<typeof BillCard>[0]["claim"]; state: BillState }> = [
  {
    bill: {
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
    state: "overcharge_no_draft",
  },
  {
    bill: {
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
    state: "clean",
  },
];

export function ClaimPreviewEmptyState() {
  return (
    <div className="relative">
      {/* Hero card — focused primary CTA + 3-step HOW IT WORKS explainer per Item 2 design */}
      <div className="mb-6 rounded-3xl border-2 border-dashed border-blue-200 bg-gradient-to-br from-white via-blue-50/60 to-blue-50 px-6 py-8 sm:px-8 sm:py-10">
        <div className="flex flex-col items-center text-center">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-white text-blue-700 ring-1 ring-blue-100 shadow-sm shadow-blue-200/40">
            <svg className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24" aria-hidden="true">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
              />
            </svg>
          </div>

          <h2 className="max-w-[22ch] text-2xl font-bold tracking-tight text-gray-900 sm:text-3xl">
            Upload your first bill to start the audit
          </h2>

          <p className="mx-auto mt-3 max-w-[52ch] text-sm leading-relaxed text-gray-600">
            Candid Claim audits every line on every bill against your plan + community benchmarks
            — flags overcharges, drafts dispute letters, and tracks every dollar you&apos;re owed
            back. <strong className="font-semibold text-gray-900">Drop in any EOB or itemized
            bill</strong> to see what Candid finds.
          </p>

          <div className="mt-5">
            <Link
              href="/upload"
              className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700"
            >
              Upload a bill
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
              </svg>
            </Link>
          </div>

          {/* HOW IT WORKS divider */}
          <div className="mx-auto mt-7 flex w-full max-w-sm items-center gap-3">
            <div className="h-px flex-1 bg-blue-100" />
            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-gray-500">
              How it works
            </div>
            <div className="h-px flex-1 bg-blue-100" />
          </div>

          {/* 3-step explainer grid */}
          <div className="mt-5 grid w-full grid-cols-1 gap-3 text-left sm:grid-cols-3">
            <Step
              num={1}
              title="Upload"
              body="EOB, itemized bill, or photo. We OCR + parse it within a minute."
            />
            <Step
              num={2}
              title="Audit"
              body="Every line gets compared to your plan terms + community pricing data."
            />
            <Step
              num={3}
              title="Recover"
              body="Overcharges become draftable appeal letters. You mail; we track."
            />
          </div>
        </div>
      </div>

      {/* Preview label — "this is what you'll see" affordance kept from prior empty-state */}
      <div className="mb-3 flex items-center gap-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">
          Preview — this is what you&apos;ll see
        </p>
        <div className="h-px flex-1 bg-gray-100" />
      </div>

      {/* Greyed preview of sample bills — load-bearing value-before-asking */}
      <div className="pointer-events-none select-none space-y-3 opacity-50">
        {SAMPLE_BILLS.map((sample) => (
          <BillCard key={sample.bill.id} claim={sample.bill} state={sample.state} onSelect={() => {}} />
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

function Step({ num, title, body }: { num: number; title: string; body: string }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl bg-white p-3.5 ring-1 ring-blue-100">
      <div className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-50 text-[11px] font-bold text-blue-700">
        {num}
      </div>
      <div className="text-sm font-bold text-gray-900">{title}</div>
      <div className="text-[11.5px] leading-relaxed text-gray-600">{body}</div>
    </div>
  );
}
