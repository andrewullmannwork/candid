/**
 * Dev-only isolated preview for the unified case timeline (S286).
 *
 * Renders the extended UnifiedTodo in its five states with mock props so
 * design review doesn't require a real authed dispute in each state:
 *   1. Draft (single letter, filing-window guard, current-row highlight)
 *   2. Sent — live schedule (awaiting + follow-ups + final notice + external
 *      review locked + stage-action bar)
 *   3. Resolved (denied) — outcome summary + "Start the next letter" CTA
 *   4. Letter 2 viewed — previous letter's checked history above the new steps
 *   5. Viewing an earlier letter — banner + later-letter pointer
 *
 * NODE_ENV-gated: returns 404 in production builds; `/dev/*` namespace is the
 * established dev-only preview surface (see /dev/doc-type-modal).
 *
 * All handlers are local no-ops; checklist persistence is session-local here.
 */

"use client";

import { Suspense } from "react";
import { notFound, useSearchParams } from "next/navigation";
import {
  UnifiedTodo,
  type CaseLetterSummary,
  type CaseTimelineEvents,
} from "@/components/disputes/UnifiedTodo";

const noop = () => {};

const mockNeedsPanel = (
  <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-6 text-center text-[12.5px] text-gray-500">
    (Embedded CaseNeedsPanel renders here — addresses, EOB, plan costs, insurance)
  </div>
);

const liveEvents: CaseTimelineEvents = {
  windowPassed: false,
  windowPassedNextStep: null,
  daysRemaining: 58,
  responseDueDateLabel: "Sep 15, 2026",
  followups: [
    { dueDate: "2026-08-16", dateLabel: "Aug 16, 2026", kind: "deadline_interim" },
    { dueDate: "2026-08-26", dateLabel: "Aug 26, 2026", kind: "deadline_final" },
  ],
  externalReviewLocked: true,
};

const twoLetters = (viewedSecond: boolean): CaseLetterSummary[] => [
  {
    id: "letter-1",
    ordinal: 1,
    label: "Billing Dispute",
    viewed: !viewedSecond,
    latest: false,
    sentDateLabel: "Jun 2, 2026",
    statusLine: "closed — denied Sep 4, 2026",
    outcomeWord: "denied",
    live: false,
    liveDueLabel: null,
    href: "#letter-1",
    steps: [
      { title: "Add the provider's mailing address", done: true },
      { title: "Confirm the claim details", done: true },
      { title: "Download & sign the letter", done: true },
      { title: "Mail it certified", done: true },
      { title: "Mark it as sent", done: true },
    ],
  },
  {
    id: "letter-2",
    ordinal: 2,
    label: "Appeal to Insurer",
    viewed: viewedSecond,
    latest: true,
    sentDateLabel: null,
    statusLine: null,
    outcomeWord: null,
    live: false,
    liveDueLabel: null,
    href: "#letter-2",
    steps: [],
  },
];

function Panel({
  n,
  only,
  title,
  note,
  children,
}: {
  n: number;
  only: number | null;
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  // ?state=N deep link — render one panel at the top (design review +
  // screenshot-friendly; the pane only captures at scroll-top).
  if (only != null && only !== n) return null;
  return (
    <div>
      <div className="mb-2">
        <span className="rounded-md bg-slate-900 px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-white">
          {title}
        </span>
        <span className="ml-2 text-[12px] text-slate-500">{note}</span>
      </div>
      {children}
    </div>
  );
}

// useSearchParams requires a Suspense boundary at the page level (same
// pattern as the disputes page).
export default function UnifiedTimelinePreviewPage() {
  return (
    <Suspense>
      <UnifiedTimelinePreview />
    </Suspense>
  );
}

function UnifiedTimelinePreview() {
  const searchParams = useSearchParams();
  const stateParam = searchParams.get("state");
  const only = stateParam ? Number(stateParam) || null : null;
  if (process.env.NODE_ENV === "production") notFound();

  const shared = {
    // S291 — preview harness has no plan-year mismatch scenario yet.
    planYearMismatch: null,
    planYearResolved: false,
    nameMismatch: null,
    nameResolved: false,
    onResolvePatient: noop,
    onOpenLetter: noop,
    onDownload: noop,
    onMarkSent: noop,
    markingSent: false,
    onAddProviderAddress: noop,
    onAddInsurerAddress: noop,
    onReportOutcome: noop,
    onCollections: noop,
    onEscalateNext: noop,
    onUndoSent: noop,
    onUndoOutcome: noop,
  } as const;

  return (
    <div className="mx-auto max-w-3xl space-y-10 p-6">
      <h1 className="text-xl font-bold text-slate-900">
        Unified case timeline — dev preview (S286)
      </h1>

      <Panel n={1} only={only} title="1 · Draft" note="Single letter; filing-window guard; static after-sent trio locked.">
        <UnifiedTodo
          {...shared}
          amountLabel="$775.00"
          sent={false}
          sentDateLabel={null}
          responseDueLabel={null}
          status="dispute_letter_drafted"
          recipientKind="insurer"
          providerAddressOnFile={false}
          insurerAddressOnFile={true}
          filingWarning={{
            passed: false,
            label: "Appeal window",
            daysRemaining: 42,
            dateLabel: "Aug 29, 2026",
            nextStep: null,
          }}
        >
          {mockNeedsPanel}
        </UnifiedTodo>
      </Panel>

      <Panel n={2} only={only} title="2 · Sent — live" note="Real schedule replaces the static trio; stage actions at the bottom.">
        <UnifiedTodo
          {...shared}
          amountLabel="$775.00"
          sent={true}
          sentDateLabel="Jul 17, 2026"
          responseDueLabel="Sep 15, 2026"
          status="filed"
          recipientKind="insurer"
          providerAddressOnFile={false}
          insurerAddressOnFile={true}
          caseEvents={liveEvents}
          initialChecks={{ mailcert: true, download: true }}
        >
          {mockNeedsPanel}
        </UnifiedTodo>
      </Panel>

      <Panel n={3} only={only} title="3 · Resolved — denied" note="Outcome summary rung + 'Start the next letter' CTA (approved copy).">
        <UnifiedTodo
          {...shared}
          amountLabel="$775.00"
          sent={true}
          sentDateLabel="Jul 17, 2026"
          responseDueLabel="Sep 15, 2026"
          status="lost"
          outcomeLine="closed — denied Sep 4, 2026"
          recipientKind="insurer"
          providerAddressOnFile={false}
          insurerAddressOnFile={true}
          caseEvents={liveEvents}
          nextStepLabel="Start the next letter — external review"
        >
          {mockNeedsPanel}
        </UnifiedTodo>
      </Panel>

      <Panel n={4} only={only} title="4 · Letter 2 viewed" note="Previous letter's checked history above the new steps; carried-details sub-line.">
        <UnifiedTodo
          {...shared}
          amountLabel="$775.00"
          sent={false}
          sentDateLabel={null}
          responseDueLabel={null}
          status="dispute_letter_drafted"
          recipientKind="insurer"
          providerAddressOnFile={false}
          insurerAddressOnFile={true}
          letters={twoLetters(true)}
        >
          {mockNeedsPanel}
        </UnifiedTodo>
      </Panel>

      <Panel n={5} only={only} title="5 · Viewing an earlier letter" note="Banner + later-letter pointer; earlier letter's own page state.">
        <UnifiedTodo
          {...shared}
          amountLabel="$775.00"
          sent={true}
          sentDateLabel="Jun 2, 2026"
          responseDueLabel={null}
          status="lost"
          outcomeLine="closed — denied Sep 4, 2026"
          recipientKind="provider"
          providerAddressOnFile={true}
          insurerAddressOnFile={false}
          letters={twoLetters(false)}
        >
          {mockNeedsPanel}
        </UnifiedTodo>
      </Panel>
    </div>
  );
}
