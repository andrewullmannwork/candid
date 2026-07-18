"use client";

/**
 * AccumulatorPanel — "Your plan spending" (Panel Redesign v2, S287).
 *
 * Candid's own cross-bill deductible/OOP running tally beside the insurer's reported
 * accumulator, from GET /api/plan/accumulators (gated `accumulator_ledger_v1`; OFF →
 * the endpoint omits the ledger → this renders null → panel hidden).
 *
 * The redesign reframes the old "us vs them" two-bar comparison as ONE tally split by
 * credit status: green = the insurer has credited it · amber-stripe = you've paid it but
 * they haven't credited it yet (the gap = potential overpayment) · gray = remaining. A
 * single consolidated banner ("Your uploaded documents show {Insurer} is behind by $X")
 * replaces the per-meter red blocks. The amber/legend/banner apparatus appears ONLY on a
 * flagged, insurer-BEHIND, medical in-network divergence (the disputable signal); every
 * other state renders one calm green bar. Collapsed by default — the banner still shows
 * when collapsed (only the progress bars hide). Light-mode inline Tailwind (D-S112-G).
 * SoT: plans/deductible_oop_accumulator_v1.md §"Panel redesign v2".
 */
import { useState } from "react";
import { cn } from "@/lib/utils/cn";
import { useAccumulatorLedger } from "./use-accumulator-ledger";
import type {
  AccumulatorLedger,
  LedgerBucket,
  NetworkBuckets,
  NetworkPair,
} from "@/lib/claims/accumulator-ledger";

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const fmt = (n: number | null | undefined) => (n == null ? "—" : usd.format(Math.round(n)));
const clampPct = (n: number) => Math.max(0, Math.min(100, n));

/** amber 45° stripe — "paid, awaiting credit" (design #f59e0b / #fcd34d). */
const STRIPE = "repeating-linear-gradient(45deg,#f59e0b 0 7px,#fcd34d 7px 14px)";
const STRIPE_SM = "repeating-linear-gradient(45deg,#f59e0b 0 3px,#fcd34d 3px 6px)";
const STRIPE_KEY = "repeating-linear-gradient(45deg,#f59e0b 0 4px,#fcd34d 4px 8px)";

/** A flagged divergence where the insurer is BEHIND us — the one disputable signal. */
function isBehind(b: LedgerBucket): boolean {
  return !!b.divergence?.flagged && b.divergence.direction === "insurer_behind";
}
/** Flagged the other way — the insurer credited MORE than our bills show (upload nudge). */
function isAhead(b: LedgerBucket): boolean {
  return !!b.divergence?.flagged && b.divergence.direction === "insurer_ahead";
}

// ── icons (inline, stroke-based; match the hi-fi paths) ─────────────────────────
function BarChart({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={cn("w-5 h-5", className)} aria-hidden="true">
      <path d="M12 20V10M18 20V4M6 20v-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function Warning({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={cn("w-4 h-4", className)} aria-hidden="true">
      <path d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function ArrowRight({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={cn("w-3.5 h-3.5 shrink-0", className)} aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function Check({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={cn("w-3.5 h-3.5 shrink-0", className)} aria-hidden="true">
      <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function Chevron({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={cn("w-[18px] h-[18px]", className)} aria-hidden="true">
      <path d="M18 15l-6-6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── legend (only rendered atop a diverged in-network block) ─────────────────────
function LegendItem({ swatch, label }: { swatch: React.ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] text-gray-500">
      {swatch}
      {label}
    </span>
  );
}
function Legend() {
  return (
    <div className="flex flex-wrap gap-x-3.5 gap-y-1.5">
      <LegendItem swatch={<span className="w-[11px] h-[11px] rounded-[3px] bg-emerald-600 shrink-0" />} label="Credited by insurer" />
      <LegendItem swatch={<span className="w-[11px] h-[11px] rounded-[3px] shrink-0" style={{ backgroundImage: STRIPE_KEY }} />} label="Paid, awaiting credit" />
      <LegendItem swatch={<span className="w-[11px] h-[11px] rounded-[3px] bg-gray-200 shrink-0" />} label="Remaining" />
    </div>
  );
}

// ── one metric row (the stacked bar) ────────────────────────────────────────────
function MetricRow({
  label,
  bucket,
  divergenceEnabled,
  nullPrompt = "Add your plan limit to track this",
}: {
  label: string;
  bucket: LedgerBucket;
  /** amber/credited split fires only on medical in-network (§ Panel redesign v2). */
  divergenceEnabled: boolean;
  /** shown when the plan term (denominator) is missing (§7b copy varies by bucket). */
  nullPrompt?: string;
}) {
  const { max, candidApplied, met } = bucket;

  // No denominator → a prompt, never a broken 0-width bar.
  if (max == null) {
    return (
      <div className="py-3.5 border-t border-gray-100 first:border-t-0">
        <div className="text-[14.5px] font-medium text-gray-700 mb-1.5">{label}</div>
        <p className="text-[12px] text-gray-400">{nullPrompt}</p>
      </div>
    );
  }

  const remain = bucket.remaining ?? Math.max(0, max - candidApplied);
  const d = bucket.divergence;
  const behind = divergenceEnabled && !!d?.flagged && d.direction === "insurer_behind";
  // A $0 limit is inherently satisfied (§18: render "met", not "nothing applied yet").
  const isMet = met || max === 0;
  const empty = candidApplied <= 0 && !behind && !isMet;

  // Stacked-segment widths, jointly clamped so green + amber never exceed the track.
  let credited = 0;
  let gap = 0;
  if (behind && d) {
    credited = clampPct((d.insurerApplied / max) * 100);
    gap = Math.min(clampPct(((candidApplied - d.insurerApplied) / max) * 100), 100 - credited);
  }
  const calmPct = max > 0 ? clampPct((candidApplied / max) * 100) : 0;

  const ariaLabel = behind && d
    ? `${label}: ${fmt(candidApplied)} of ${fmt(max)}; insurer credited ${fmt(d.insurerApplied)}, ${fmt(d.gap)} awaiting credit`
    : `${label}: ${fmt(candidApplied)} of ${fmt(max)}, ${fmt(remain)} left`;

  return (
    <div className="py-3.5 border-t border-gray-100 first:border-t-0">
      <div className="flex justify-between items-baseline gap-3 mb-2.5">
        <span className={cn("text-[14.5px] font-medium", empty ? "text-gray-400" : "text-gray-700")}>{label}</span>
        <span className={cn("text-[15px] font-bold tabular-nums", empty ? "text-gray-400" : "text-gray-900")}>
          {fmt(candidApplied)} <span className="font-medium text-gray-400">of {fmt(max)}</span>
        </span>
      </div>

      <div className="flex h-3.5 rounded-full bg-gray-100 overflow-hidden" role="img" aria-label={ariaLabel}>
        {behind ? (
          <>
            {credited > 0 && (
              <span className="h-full box-border border-r-2 border-white bg-emerald-600" style={{ width: `${credited}%` }} />
            )}
            {gap > 0 && (
              <span className="h-full box-border border-r-2 border-white" style={{ width: `${gap}%`, backgroundImage: STRIPE }} />
            )}
          </>
        ) : isMet ? (
          <span className="h-full w-full bg-emerald-600" />
        ) : (
          !empty && calmPct > 0 && <span className="h-full bg-emerald-600" style={{ width: `${calmPct}%` }} />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2.5 text-[12px]">
        {behind && d ? (
          <>
            <span className="inline-flex items-center gap-1.5 text-gray-500">
              <span className="w-2 h-2 rounded-sm bg-emerald-600 shrink-0" />
              <b className="font-semibold text-gray-700 tabular-nums">{fmt(d.insurerApplied)}</b> credited
            </span>
            <span className="inline-flex items-center gap-1.5 text-gray-500">
              <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundImage: STRIPE_SM }} />
              <b className="font-semibold text-gray-700 tabular-nums">{fmt(d.gap)}</b> awaiting credit
            </span>
            <span className="ml-auto text-gray-400 tabular-nums">{fmt(remain)} left</span>
          </>
        ) : isMet ? (
          <span className="inline-flex items-center gap-1.5 text-emerald-700 font-medium">
            <Check className="w-3.5 h-3.5" /> Met
          </span>
        ) : empty ? (
          <>
            <span className="text-gray-400">Nothing applied yet</span>
            <span className="ml-auto text-gray-400 tabular-nums">{fmt(remain)} left</span>
          </>
        ) : (
          <>
            {isAhead(bucket) && bucket.divergence ? (
              <span className="text-gray-400 tabular-nums">
                Insurer shows {fmt(bucket.divergence.insurerApplied)} — you may have unadded bills
              </span>
            ) : null}
            <span className="ml-auto text-gray-400 tabular-nums">{fmt(remain)} left</span>
          </>
        )}
      </div>
    </div>
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

function NetworkBlock({
  title,
  buckets,
  divergenceEnabled,
}: {
  title: string;
  buckets: NetworkBuckets;
  divergenceEnabled: boolean;
}) {
  if (!sectionHasSignal(buckets)) return null;
  const showLegend = divergenceEnabled && (isBehind(buckets.deductible) || isBehind(buckets.oop));
  return (
    <div className="mt-6 first:mt-0">
      <div className="flex items-baseline justify-between gap-3 flex-wrap mb-1.5">
        <h4 className="text-[12px] font-bold uppercase tracking-[0.08em] text-gray-700">{title}</h4>
        {showLegend && <Legend />}
      </div>
      <MetricRow label="Deductible" bucket={buckets.deductible} divergenceEnabled={divergenceEnabled} />
      <MetricRow label="Out-of-pocket max" bucket={buckets.oop} divergenceEnabled={divergenceEnabled} />
    </div>
  );
}

// ── consolidated "insurer is behind" banner ─────────────────────────────────────
/** Resolve the single banner from the medical in-network buckets (deductible first). */
function resolveBanner(pair: NetworkPair): { metric: string; gap: number; credited: number; candid: number; met: boolean } | null {
  const pick = isBehind(pair.in.deductible)
    ? { bucket: pair.in.deductible, metric: "deductible" }
    : isBehind(pair.in.oop)
      ? { bucket: pair.in.oop, metric: "out-of-pocket max" }
      : null;
  const d = pick?.bucket.divergence;
  if (!pick || !d) return null;
  return { metric: pick.metric, gap: d.gap, credited: d.insurerApplied, candid: pick.bucket.candidApplied, met: pick.bucket.met };
}

function GapBanner({
  insurer,
  metric,
  gap,
  credited,
  candid,
  met,
}: {
  insurer: string;
  metric: string;
  gap: number;
  credited: number;
  candid: number;
  met: boolean;
}) {
  return (
    <div className="flex items-center gap-3.5 p-3.5 bg-amber-50 border border-amber-200 rounded-2xl flex-wrap sm:flex-nowrap">
      <div className="w-[30px] h-[30px] rounded-lg bg-white border border-amber-200 text-amber-600 flex items-center justify-center shrink-0">
        <Warning className="w-[18px] h-[18px]" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[14.5px] font-bold text-gray-900 tracking-[-0.01em]">
          Your uploaded documents show {insurer} is behind by <span className="tabular-nums">{fmt(gap)}</span>
        </p>
        <p className="text-[13px] leading-[1.45] text-gray-600 mt-0.5">
          {met ? (
            <>
              Your bills show your {metric} is met, but {insurer} has credited only{" "}
              <b className="font-semibold text-gray-900 tabular-nums">{fmt(credited)}</b>. Until they catch up, you may be overpaying.
            </>
          ) : (
            <>
              Bills show <b className="font-semibold text-gray-900 tabular-nums">{fmt(candid)}</b> paid toward your in-network limits;{" "}
              {insurer} has credited only <b className="font-semibold text-gray-900 tabular-nums">{fmt(credited)}</b>. Until they catch up, you may be overpaying.
            </>
          )}
        </p>
      </div>
      <a
        href="/claim"
        className="shrink-0 w-full sm:w-auto justify-center inline-flex items-center gap-1.5 text-[13px] font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-xl px-3.5 py-2.5 shadow-lg shadow-blue-600/20 hover:-translate-y-px transition self-stretch sm:self-center"
      >
        Review &amp; dispute
        <ArrowRight />
      </a>
    </div>
  );
}

/** In-network behind-flagged buckets — the disputable count for "N to review". */
function countBehind(pair: NetworkPair): number {
  return [pair.in.deductible, pair.in.oop].filter(isBehind).length;
}

/** True when the insurer's OWN accumulator confirms our in-network tally (§9 `match`)
 *  and nothing is behind — the reassuring "all square" state (never claims confirmation
 *  we don't have: requires an actual insurer `match`, not merely missing insurer data). */
function isOnTrack(pair: NetworkPair): boolean {
  const buckets = [pair.in.deductible, pair.in.oop];
  return (
    buckets.some((b) => b.divergence?.direction === "match") &&
    !buckets.some(isBehind) &&
    !buckets.some(isAhead)
  );
}

interface ViewProps {
  ledger: AccumulatorLedger;
  insurer?: string | null;
  className?: string;
  /** Start expanded (default false → collapsed). Used by the dev preview; prod stays collapsed. */
  defaultCollapsed?: boolean;
}

/** Pure presentation — takes a ledger, no data fetching (so the preview page can drive it). */
export function AccumulatorPanelView({ ledger, insurer, className, defaultCollapsed = true }: ViewProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  const pair = ledger.individual ?? ledger.familyAggregate ?? ledger.familyEmbedded?.cap ?? null;
  if (!pair) return null;

  const scopeLabel = ledger.scope === "individual" ? "individual coverage" : "family coverage";
  const insurerName = insurer?.trim() || "your insurer";
  const banner = resolveBanner(pair);
  const onTrack = !banner && isOnTrack(pair);
  const reviewCount = countBehind(pair);

  return (
    <div className={cn(className)}>
      {/* Collapsible header (always visible). */}
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className="w-full flex items-center gap-3.5 text-left"
      >
        <div className="w-[42px] h-[42px] rounded-xl bg-gray-50 border border-gray-200 text-gray-600 flex items-center justify-center shrink-0">
          <BarChart />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-[19px] font-bold text-gray-900 tracking-[-0.01em] leading-tight">Your plan spending</h3>
          <p className="text-[13px] text-gray-500 mt-0.5">
            {ledger.planYear} plan year · {scopeLabel}
          </p>
        </div>
        <Chevron className={cn("text-gray-400 transition-transform shrink-0", collapsed && "rotate-180")} />
      </button>

      {/* Status line — the collapsed-state headline; stays visible whether or not expanded.
          Insurer behind → amber dispute banner; insurer-confirmed match → green "on track". */}
      {banner ? (
        <div className="mt-5">
          <GapBanner
            insurer={insurerName}
            metric={banner.metric}
            gap={banner.gap}
            credited={banner.credited}
            candid={banner.candid}
            met={banner.met}
          />
        </div>
      ) : onTrack ? (
        <div className="mt-5">
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-[13px] font-medium text-emerald-700">
            <Check className="w-4 h-4 text-emerald-600" />
            On track with {insurerName}
          </span>
        </div>
      ) : null}

      {/* Progress bars — the ONLY thing the collapse hides. */}
      {!collapsed && (
        <div className="mt-5">
          <NetworkBlock title="In-network progress" buckets={pair.in} divergenceEnabled />
          <NetworkBlock title="Out-of-network progress" buckets={pair.out} divergenceEnabled={false} />
          {ledger.rxDeductible && (
            <div className="mt-6">
              <h4 className="text-[12px] font-bold uppercase tracking-[0.08em] text-gray-700 mb-1.5">Prescriptions</h4>
              <MetricRow
                label="Prescription deductible"
                bucket={ledger.rxDeductible}
                divergenceEnabled={false}
                nullPrompt="Add your prescription deductible"
              />
            </div>
          )}
        </div>
      )}

      {/* Footer (always visible). */}
      <div className="mt-5 pt-3.5 border-t border-gray-100 flex items-center justify-between gap-3 flex-wrap text-[12.5px]">
        <span className="text-gray-400">
          {`Tallied from ${ledger.billsCounted} ${ledger.billsCounted === 1 ? "bill" : "bills"} you've uploaded`}
        </span>
        {reviewCount > 0 && (
          <a href="/claim" className="inline-flex items-center gap-1.5 font-semibold text-amber-700 hover:text-amber-800">
            <Warning className="w-3.5 h-3.5" />
            {reviewCount} to review
          </a>
        )}
      </div>
    </div>
  );
}

interface Props {
  insurancePlanId?: string | null;
  planYear?: number | null;
  insurer?: string | null;
  className?: string;
}

/** Data wrapper — fetches the ledger (gated) and hands it to the pure view. */
export function AccumulatorPanel({ insurancePlanId, planYear, insurer, className }: Props) {
  const ledger = useAccumulatorLedger(insurancePlanId, planYear);
  if (!ledger) return null;
  return <AccumulatorPanelView ledger={ledger} insurer={insurer} className={className} />;
}
