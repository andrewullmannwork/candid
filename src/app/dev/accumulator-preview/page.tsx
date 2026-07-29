/**
 * DEV-ONLY throwaway preview for the Panel Redesign v2 (S286). Renders
 * AccumulatorPanelView against hand-built ledgers covering every visual state, inside a
 * mock "plan card" that mimics the merged PlanSummaryCard context. Untracked; delete
 * post-session. Unauthed (no data fetch) so it renders in any browser. Server component
 * per the /dev convention (S121): self-guards to notFound() outside development.
 */
import { notFound } from "next/navigation";
import { AccumulatorPanelView } from "@/components/plan/AccumulatorPanel";
import type {
  AccumulatorLedger,
  LedgerBucket,
  BucketDivergence,
} from "@/lib/claims/accumulator-ledger";

function bucket(
  candidApplied: number,
  max: number | null,
  opts: { insurerApplied?: number; met?: boolean; estimated?: boolean } = {},
): LedgerBucket {
  const remaining = max == null ? null : Math.max(0, max - candidApplied);
  const met = opts.met ?? (max != null && candidApplied >= max);
  let divergence: BucketDivergence | undefined;
  if (opts.insurerApplied != null && max != null) {
    const gap = Math.round((candidApplied - opts.insurerApplied) * 100) / 100;
    const material = Math.abs(gap) >= Math.max(25, max * 0.02);
    const direction = gap > 0 ? "insurer_behind" : gap < 0 ? "insurer_ahead" : "match";
    divergence = {
      insurerApplied: opts.insurerApplied,
      gap,
      direction,
      flagged: material && !opts.estimated && direction !== "match",
      ...(opts.estimated && material ? { suppressedReason: "estimated_tally" as const } : {}),
    };
  }
  return {
    candidApplied,
    max,
    remaining,
    met,
    confidence: opts.estimated ? "estimated" : "adjudicated",
    divergence,
  };
}

const empty = (max: number | null): LedgerBucket => bucket(0, max);

// Scenario ledgers ────────────────────────────────────────────────────────────
const diverged: AccumulatorLedger = {
  planYear: 2026,
  billsCounted: 2,
  droppedDuplicates: 0,
  scope: "individual",
  individual: {
    in: {
      deductible: bucket(1326, 3000, { insurerApplied: 750 }),
      oop: bucket(1326, 5000, { insurerApplied: 750 }),
    },
    out: { deductible: empty(5500), oop: empty(25000) },
  },
};

const matched: AccumulatorLedger = {
  planYear: 2026,
  billsCounted: 3,
  droppedDuplicates: 0,
  scope: "individual",
  individual: {
    in: {
      deductible: bucket(1200, 3000, { insurerApplied: 1200 }),
      oop: bucket(1200, 6000, { insurerApplied: 1200 }),
    },
    out: { deductible: empty(5500), oop: empty(25000) },
  },
};

const met: AccumulatorLedger = {
  planYear: 2026,
  billsCounted: 5,
  droppedDuplicates: 0,
  scope: "individual",
  individual: {
    in: {
      deductible: bucket(3000, 3000, { insurerApplied: 3000, met: true }),
      oop: bucket(3800, 6000, { insurerApplied: 3800 }),
    },
    out: { deductible: empty(5500), oop: empty(25000) },
  },
};

const estimated: AccumulatorLedger = {
  planYear: 2026,
  billsCounted: 1,
  droppedDuplicates: 0,
  scope: "individual",
  individual: {
    in: {
      // material gap but our tally is estimated → suppressed, no banner (can't accuse).
      deductible: bucket(900, 2000, { insurerApplied: 300, estimated: true }),
      oop: bucket(900, 4000, { estimated: true }),
    },
    out: { deductible: empty(4000), oop: empty(12000) },
  },
};

const ahead: AccumulatorLedger = {
  planYear: 2026,
  billsCounted: 1,
  droppedDuplicates: 0,
  scope: "individual",
  individual: {
    in: {
      deductible: bucket(400, 2000, { insurerApplied: 1200 }),
      oop: bucket(400, 5000, { insurerApplied: 1200 }),
    },
    out: { deductible: empty(5000), oop: empty(15000) },
  },
};

const withRx: AccumulatorLedger = {
  planYear: 2026,
  billsCounted: 4,
  droppedDuplicates: 0,
  scope: "family_aggregate",
  familyAggregate: {
    in: {
      deductible: bucket(1326, 6000, { insurerApplied: 750 }),
      oop: bucket(1326, 12000, { insurerApplied: 750 }),
    },
    out: { deductible: empty(12000), oop: empty(36000) },
  },
  rxDeductible: bucket(150, 500, { insurerApplied: 150 }),
};

const noLimits: AccumulatorLedger = {
  planYear: 2026,
  billsCounted: 0,
  droppedDuplicates: 0,
  scope: "individual",
  individual: {
    in: { deductible: bucket(0, null), oop: bucket(0, null) },
    out: { deductible: bucket(0, null), oop: bucket(0, null) },
  },
  rxDeductible: bucket(0, null),
};

const STATS: Record<string, [string, string][]> = {
  default: [
    ["Deductible · in-network", "$3,000"],
    ["Deductible · out-of-net", "$5,500"],
    ["OOP max · in-network", "$5,000"],
    ["OOP max · out-of-net", "$25,000"],
  ],
};

function MockCard({
  title,
  note,
  planName,
  insurer,
  ledger,
  defaultCollapsed,
}: {
  title: string;
  note: string;
  planName: string;
  insurer: string;
  ledger: AccumulatorLedger;
  defaultCollapsed: boolean;
}) {
  return (
    <div className="mb-8">
      <div className="mb-2">
        <span className="text-[13px] font-bold text-gray-900">{title}</span>
        <span className="text-[12px] text-gray-500"> — {note}</span>
      </div>
      <div className="max-w-[760px] p-5 bg-white border border-gray-200 rounded-2xl">
        {/* mock plan header (stand-in for PlanSummaryCard) */}
        <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-blue-600">Your plan on file</p>
        <h3 className="mt-1 text-base font-semibold text-gray-900">
          {insurer} {planName}
          <span className="ml-2 text-[11px] font-semibold text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded">PPO</span>
        </h3>
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
          {STATS.default.map(([l, v]) => (
            <div key={l} className="min-w-0">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">{l}</p>
              <p className="mt-0.5 text-sm font-medium text-gray-900 tabular-nums">{v}</p>
            </div>
          ))}
        </div>
        {/* merged spending section with the divider */}
        <div className="mt-5 pt-5 border-t border-gray-100">
          <AccumulatorPanelView ledger={ledger} insurer={insurer} defaultCollapsed={defaultCollapsed} />
        </div>
      </div>
    </div>
  );
}

export default function AccumulatorPreviewPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return (
    <div className="min-h-screen bg-gray-50 px-6 py-10">
      <div className="max-w-[820px] mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Accumulator Panel — Redesign v2 preview</h1>
        <p className="text-sm text-gray-500 mb-8">Dev-only. Every visual state against mock ledgers.</p>

        <MockCard
          title="1 · Diverged (collapsed — default)"
          note="insurer behind; banner is the collapsed headline, bars hidden"
          planName="Platinum 90 PPO"
          insurer="Blue Shield"
          ledger={diverged}
          defaultCollapsed
        />
        <MockCard
          title="1b · Matched (collapsed — the common case)"
          note="agrees with insurer → no banner; collapsed shows only header + footer"
          planName="Gold 80 HMO"
          insurer="Kaiser"
          ledger={matched}
          defaultCollapsed
        />
        <MockCard
          title="2 · Diverged (expanded)"
          note="stacked bars: green credited + amber awaiting + gray remaining; legend"
          planName="Platinum 90 PPO"
          insurer="Blue Shield"
          ledger={diverged}
          defaultCollapsed={false}
        />
        <MockCard
          title="3 · Matched (expanded)"
          note="agrees with insurer → calm green bars, no amber, no banner"
          planName="Gold 80 HMO"
          insurer="Kaiser"
          ledger={matched}
          defaultCollapsed={false}
        />
        <MockCard
          title="4 · Deductible met (expanded)"
          note="full green + ✓ Met"
          planName="Gold 80 HMO"
          insurer="Kaiser"
          ledger={met}
          defaultCollapsed={false}
        />
        <MockCard
          title="5 · Estimated tally (expanded)"
          note="material gap but our tally is estimated → suppressed, no banner"
          planName="Silver 70 EPO"
          insurer="Anthem"
          ledger={estimated}
          defaultCollapsed={false}
        />
        <MockCard
          title="6 · Insurer ahead (expanded)"
          note="insurer credited more than our bills → calm bar + unadded-bills nudge, no banner"
          planName="Silver 70 EPO"
          insurer="Anthem"
          ledger={ahead}
          defaultCollapsed={false}
        />
        <MockCard
          title="7 · Family + Rx (expanded)"
          note="family coverage label; Rx deductible meter (calm)"
          planName="Platinum 90 PPO"
          insurer="Blue Shield"
          ledger={withRx}
          defaultCollapsed={false}
        />
        <MockCard
          title="8 · No plan limits (expanded)"
          note="missing denominators → add-your-limit prompts, no broken bars"
          planName="Bronze 60"
          insurer="Oscar"
          ledger={noLimits}
          defaultCollapsed={false}
        />
      </div>
    </div>
  );
}
