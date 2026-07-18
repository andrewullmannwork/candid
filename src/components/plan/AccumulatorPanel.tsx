"use client";

/**
 * AccumulatorPanel — "Your plan spending" (Phase 2 display).
 *
 * Candid's own cross-bill deductible/OOP running tally beside the insurer's reported
 * accumulator, from GET /api/plan/accumulators (gated `accumulator_ledger_v1`; OFF →
 * the endpoint omits the ledger → this renders null → panel hidden). Progressive
 * disclosure keyed on agreement: a matched bucket is one calm emerald bar + "matches
 * your insurer"; a flagged divergence expands into a red-outlined two-bar comparison +
 * the plain-dollar gap + a review action. Color is semantic — emerald = your Candid
 * tally, red = the insurer's shortfall, neutral = magnitude. Light-mode; inline
 * Tailwind (D-S112-G). SoT: plans/deductible_oop_accumulator_v1.md §7.
 */
import { cn } from "@/lib/utils/cn";
import { useAccumulatorLedger } from "./use-accumulator-ledger";
import type {
  AccumulatorLedger,
  LedgerBucket,
  NetworkBuckets,
} from "@/lib/claims/accumulator-ledger";

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const fmt = (n: number | null | undefined) => (n == null ? "—" : usd.format(Math.round(n)));
const pct = (applied: number, max: number | null) =>
  max && max > 0 ? Math.max(0, Math.min(100, Math.round((applied / max) * 100))) : 0;

function Check({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={cn("w-3.5 h-3.5 shrink-0", className)} aria-hidden="true">
      <path d="M4.5 10.5l3.5 3.5 7.5-8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function Alert({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={cn("w-3.5 h-3.5 shrink-0", className)} aria-hidden="true">
      <path d="M10 3.2l7 12.8H3L10 3.2z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M10 8.4v3.1M10 13.7v.3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
function ArrowRight({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={cn("w-3.5 h-3.5 shrink-0", className)} aria-hidden="true">
      <path d="M4 10h11M11 5.5L15.5 10 11 14.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function Gauge({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={cn("w-5 h-5", className)} aria-hidden="true">
      <path d="M3.5 14a6.5 6.5 0 1113 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M10 14l3.2-3.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function Bar({ tone, value }: { tone: "emerald" | "red"; value: number }) {
  return (
    <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
      <div
        className={cn("h-full rounded-full", tone === "emerald" ? "bg-emerald-500" : "bg-red-400")}
        style={{ width: `${value}%` }}
      />
    </div>
  );
}

/** One labeled comparison bar inside the diverged block (yours vs the insurer's). */
function CompareBar({
  label,
  value,
  max,
  tone,
}: {
  label: string;
  value: number;
  max: number | null;
  tone: "emerald" | "red";
}) {
  return (
    <div className="mb-2.5 last:mb-0">
      <div className="flex justify-between items-baseline mb-1">
        <span className="text-[13px] text-gray-500">{label}</span>
        <span className="text-[13px] text-gray-500 tabular-nums">
          <span className="text-gray-900 font-medium">{fmt(value)}</span> of {fmt(max)}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
        <div
          className={cn("h-full rounded-full", tone === "emerald" ? "bg-emerald-500" : "bg-red-400")}
          style={{ width: `${pct(value, max)}%` }}
        />
      </div>
    </div>
  );
}

function DivergedMeter({ label, bucket }: { label: string; bucket: LedgerBucket }) {
  const d = bucket.divergence!;
  const behind = d.direction === "insurer_behind";
  const lower = label.toLowerCase();
  return (
    <div className="rounded-xl border border-red-200 p-4 mb-4">
      <div className="flex justify-between items-center gap-2.5 mb-3.5">
        <span className="text-[15px] font-medium text-gray-900">{label}</span>
        <span className="inline-flex items-center gap-1.5 text-red-600 text-[12px] px-2 py-1 rounded-full border border-red-200 whitespace-nowrap">
          <Alert className="w-3 h-3" />
          Doesn&apos;t match your insurer
        </span>
      </div>
      <CompareBar label="By your Candid bills" value={bucket.candidApplied} max={bucket.max} tone="emerald" />
      <CompareBar label="Your insurer&apos;s EOB" value={d.insurerApplied} max={bucket.max} tone="red" />
      <p className="text-[13px] text-gray-900 leading-relaxed mt-3 mb-3">
        A <span className="font-medium text-red-600 tabular-nums">{fmt(Math.abs(d.gap))}</span> gap.{" "}
        {behind
          ? `Your insurer shows your ${lower} isn't met — but your Candid-uploaded bills say it is. You may be paying toward a ${lower} you've already met.`
          : "Your insurer shows more than your uploaded bills do — you may have bills you haven't added yet."}
      </p>
      {behind && (
        <a
          href="/claim"
          className="inline-flex items-center gap-1.5 text-[13px] font-medium text-gray-900 border border-gray-300 rounded-lg px-3.5 py-2 hover:bg-gray-50 transition-colors"
        >
          Review and dispute
          <ArrowRight />
        </a>
      )}
    </div>
  );
}

function SimpleMeter({ label, bucket }: { label: string; bucket: LedgerBucket }) {
  const matched = bucket.divergence != null && bucket.divergence.direction === "match";
  return (
    <div className="mb-4">
      <div className="flex justify-between items-baseline mb-1.5">
        <span className="text-sm text-gray-900">{label}</span>
        <span className="text-[13px] text-gray-500 tabular-nums">
          <span className="text-gray-900 font-medium">{fmt(bucket.candidApplied)}</span> of {fmt(bucket.max)}
        </span>
      </div>
      <Bar tone="emerald" value={pct(bucket.candidApplied, bucket.max)} />
      <div className="mt-1.5 text-[12px] text-gray-500 flex items-center gap-1.5">
        {bucket.met ? (
          <>
            <Check className="text-emerald-600" />
            <span className="text-emerald-700">Met</span>
            {matched && <span className="text-gray-400">· matches your insurer</span>}
          </>
        ) : matched ? (
          <>
            <Check className="text-emerald-600" />
            Matches your insurer
            {bucket.remaining != null && <span className="tabular-nums">· {fmt(bucket.remaining)} left</span>}
          </>
        ) : bucket.remaining != null ? (
          <span className="tabular-nums">{fmt(bucket.remaining)} left</span>
        ) : (
          <span>Add your plan limit to track this</span>
        )}
      </div>
    </div>
  );
}

function AccumulatorMeter({ label, bucket }: { label: string; bucket: LedgerBucket }) {
  return bucket.divergence?.flagged ? (
    <DivergedMeter label={label} bucket={bucket} />
  ) : (
    <SimpleMeter label={label} bucket={bucket} />
  );
}

function sectionHasSignal(nb: NetworkBuckets): boolean {
  return (
    nb.deductible.max != null ||
    nb.oop.max != null ||
    nb.deductible.candidApplied > 0 ||
    nb.oop.candidApplied > 0
  );
}

function NetworkSection({ label, buckets }: { label: string; buckets: NetworkBuckets }) {
  if (!sectionHasSignal(buckets)) return null;
  return (
    <div className="mb-1">
      <div className="text-[13px] font-medium text-gray-500 mb-3">{label}</div>
      <AccumulatorMeter label="Deductible" bucket={buckets.deductible} />
      <AccumulatorMeter label="Out-of-pocket max" bucket={buckets.oop} />
    </div>
  );
}

function countFlagged(l: AccumulatorLedger): number {
  const pair = l.individual ?? l.familyAggregate ?? l.familyEmbedded?.cap;
  if (!pair) return 0;
  let n = 0;
  for (const nb of [pair.in, pair.out]) {
    for (const b of [nb.deductible, nb.oop]) {
      if (b.divergence?.flagged) n++;
    }
  }
  return n;
}

interface Props {
  insurancePlanId?: string | null;
  planYear?: number | null;
  className?: string;
}

export function AccumulatorPanel({ insurancePlanId, planYear, className }: Props) {
  const ledger = useAccumulatorLedger(insurancePlanId, planYear);

  if (!ledger) return null;
  const pair = ledger.individual ?? ledger.familyAggregate ?? ledger.familyEmbedded?.cap ?? null;
  if (!pair) return null;

  const scopeLabel = ledger.scope === "individual" ? "individual coverage" : "family coverage";
  const flagged = countFlagged(ledger);

  return (
    <section className={cn("rounded-2xl border border-gray-200 bg-white p-5 sm:p-6", className)}>
      <div className="flex items-center gap-3 mb-5">
        <div className="w-9 h-9 rounded-lg bg-gray-100 text-gray-500 flex items-center justify-center">
          <Gauge />
        </div>
        <div>
          <h3 className="text-base font-medium text-gray-900">Your plan spending</h3>
          <p className="text-[13px] text-gray-500">
            {ledger.planYear} plan year · {scopeLabel}
          </p>
        </div>
      </div>

      <NetworkSection label="In-network" buckets={pair.in} />
      <NetworkSection label="Out-of-network" buckets={pair.out} />

      {ledger.rxDeductible && (
        <div className="mb-1">
          <div className="text-[13px] font-medium text-gray-500 mb-3">Prescriptions</div>
          <AccumulatorMeter label="Prescription deductible" bucket={ledger.rxDeductible} />
        </div>
      )}

      <div className="mt-3 pt-3.5 border-t border-gray-100 flex items-center justify-between gap-3 flex-wrap text-[12px] text-gray-400">
        <span>
          Tallied from {ledger.billsCounted} {ledger.billsCounted === 1 ? "bill" : "bills"} you&apos;ve uploaded
        </span>
        {flagged > 0 && (
          <span className="text-red-600 inline-flex items-center gap-1.5">
            <Alert className="w-3.5 h-3.5" />
            {flagged} to review
          </span>
        )}
      </div>
    </section>
  );
}
