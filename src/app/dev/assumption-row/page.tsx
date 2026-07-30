/**
 * Dev-only preview of the shared `Row` primitive in its flagged / unflagged
 * states (S292).
 *
 * WHY THIS EXISTS: the flagged row's amber border is only reachable on an
 * authenticated bill-detail page, so CSS geometry was being changed by
 * reasoning about class names instead of by looking at the rendered result —
 * and it was wrong twice. This reproduces the exact card shell + row container
 * from CostShareBanner so the border can be checked directly.
 *
 * Mirrors, verbatim:
 *   card shell  — CostShareBanner.tsx (assumptionsOnly): "overflow-hidden rounded-[18px] border border-gray-200 bg-white"
 *   row wrapper — CostShareBanner.tsx: "px-5 pb-4 pt-1.5 [&>div:first-child]:border-t-0 [&>div[data-flagged]+div]:border-t-0"
 */
import { notFound } from "next/navigation";
import { Row } from "@/components/shared/InputRow";

const DocIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h6" />
  </svg>
);
const DollarIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
  </svg>
);

const GhostBtn = ({ label }: { label: string }) => (
  <button type="button" className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-[13px] font-medium text-gray-700">
    {label}
  </button>
);

/** The inner content of a Row, so the option cards can vary ONLY the wrapper. */
function RowBody({ label }: { label: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-3">
        <div className="grid h-9 w-9 flex-none place-items-center rounded-xl bg-gray-100 text-gray-500">{DocIcon}</div>
        <div className="min-w-0 pt-0.5">
          <div className="text-sm font-medium text-gray-900">{label}</div>
          <div className="mt-0.5 text-[13px] leading-snug text-gray-600">
            This bill is from 2025, but we checked it against your 2026 plan. Coverage changes year
            to year — add your 2025 plan for an accurate check.
          </div>
        </div>
      </div>
      <div className="pt-1"><GhostBtn label="Change" /></div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="mb-2 text-sm font-semibold text-gray-500">{title}</h2>
      <div className="overflow-hidden rounded-[18px] border border-gray-200 bg-white">
        <div className="px-5 pb-4 pt-1.5 [&>div:first-child]:border-t-0 [&>div[data-flagged]+div]:border-t-0">{children}</div>
      </div>
    </section>
  );
}

export default function AssumptionRowPreview() {
  if (process.env.NODE_ENV !== "development") notFound();

  const planRow = (flagged: boolean) => (
    <Row
      flagged={flagged}
      icon={DocIcon}
      label="Plan we checked against"
      control={<GhostBtn label="Change" />}
    >
      This bill is from 2025, but we checked it against your 2026 plan. Coverage changes year to
      year — add your 2025 plan for an accurate check.
    </Row>
  );
  const oopRow = (flagged: boolean) => (
    <Row flagged={flagged} icon={DollarIcon} label="Out-of-pocket max" control={<GhostBtn label="Not hit" />}>
      You haven&apos;t hit your $10,000.00 out-of-pocket max yet, so this applies to it.
    </Row>
  );
  const costRow = (flagged: boolean) => (
    <Row flagged={flagged} icon={DocIcon} label="Plan cost" control={<GhostBtn label="Edit" />}>
      We have $30 copay as your plan&apos;s cost for Primary Care Visit. Confirm it&apos;s right.
    </Row>
  );

  return (
    <main className="mx-auto max-w-3xl bg-[#fafafa] p-10">
      <h1 className="mb-8 text-xl font-bold">Assumption row — flagged vs unflagged</h1>

      <Card title="A — first row flagged (the reported case)">
        {planRow(true)}
        {oopRow(false)}
        {costRow(false)}
      </Card>

      <Card title="B — nothing flagged (after Done, badge green)">
        {planRow(false)}
        {oopRow(false)}
        {costRow(false)}
      </Card>

      <Card title="C — every incomplete row flagged">
        {planRow(true)}
        {oopRow(true)}
        {costRow(true)}
      </Card>

      <Card title="D — a middle row flagged only">
        {planRow(false)}
        {oopRow(true)}
        {costRow(false)}
      </Card>

      {/* ── Border treatments, rendered side by side so the choice is visual ── */}
      <h2 className="mb-3 mt-12 text-lg font-bold">Border treatment options</h2>

      <Card title="OPTION 1 — bleed outward (current: -mx-3 px-3). Box edges match neither the card nor the content column.">
        <div className="my-1.5 -mx-3 rounded-xl border border-amber-400 px-3 py-3.5">
          <RowBody label="Plan we checked against" />
        </div>
        {oopRow(false)}
      </Card>

      <Card title="OPTION 2 — flush with the content column (no -mx, no px). Border sits exactly where the divider lines do.">
        <div className="my-1.5 rounded-xl border border-amber-400 py-3.5">
          <RowBody label="Plan we checked against" />
        </div>
        {oopRow(false)}
      </Card>

      <Card title="OPTION 3 — full bleed to the card edge (-mx-5 px-5, square sides). Reads as a band across the whole card.">
        <div className="-mx-5 border-y border-amber-400 bg-amber-50/40 px-5 py-3.5">
          <RowBody label="Plan we checked against" />
        </div>
        {oopRow(false)}
      </Card>

      <div className="mb-10">
        <h2 className="mb-2 text-sm font-semibold text-gray-500">
          OPTION 4 — the whole card is outlined amber while anything is incomplete; rows keep their normal dividers.
        </h2>
        <div className="overflow-hidden rounded-[18px] border-2 border-amber-400 bg-white">
          <div className="px-5 pb-4 pt-1.5 [&>div:first-child]:border-t-0 [&>div[data-flagged]+div]:border-t-0">
            {planRow(false)}
            {oopRow(false)}
            {costRow(false)}
          </div>
        </div>
      </div>
    </main>
  );
}
