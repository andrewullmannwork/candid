"use client";
/**
 * Usage stats card — 4-stat grid + multiplier milestone copy.
 *
 * Data sourced from /api/billing/usage (Pattern 1 #14 user-scoped). Milestone
 * copy is suppressed when multiplier <= 1 (new subscriber / Free user / zero
 * recovery to date); cap display at 1000× for readability.
 */

interface UsageStatsCardProps {
  totalRecovered: number;
  disputesDrafted: number;
  billsAudited: number;
  plansParsed: number;
  multiplier: number;
  loading?: boolean;
}

function formatCurrency(amount: number): string {
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatMultiplier(m: number): string {
  if (m >= 1000) return "1,000×+";
  return `${Math.floor(m).toLocaleString("en-US")}×`;
}

interface StatProps {
  label: string;
  value: string | number;
  sub: string;
  toneClass: string;
}

function Stat({ label, value, sub, toneClass }: StatProps) {
  return (
    <div className={`rounded-xl border p-3 ${toneClass}`}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.1em] opacity-70">
        {label}
      </div>
      <div className="mt-1.5 text-xl font-bold leading-none">{value}</div>
      <div className="mt-1.5 text-[11px] opacity-70">{sub}</div>
    </div>
  );
}

export function UsageStatsCard({
  totalRecovered,
  disputesDrafted,
  billsAudited,
  plansParsed,
  multiplier,
  loading = false,
}: UsageStatsCardProps) {
  const showMilestone = multiplier >= 1;

  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.15em] text-gray-500">
        This period
      </div>
      <h2 className="mt-1 text-base font-bold text-gray-900">
        What Candid Pro has done for you
      </h2>

      {loading ? (
        <div className="mt-4 grid grid-cols-2 gap-2.5">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-[88px] rounded-xl border border-gray-100 bg-gray-50 animate-pulse"
            />
          ))}
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-2.5">
          <Stat
            label="Recovered"
            value={formatCurrency(totalRecovered)}
            sub="From settled disputes"
            toneClass="border-emerald-100 bg-emerald-50 text-emerald-900"
          />
          <Stat
            label="Disputes drafted"
            value={disputesDrafted.toLocaleString("en-US")}
            sub="Ready to mail"
            toneClass="border-blue-100 bg-blue-50 text-blue-900"
          />
          <Stat
            label="Bills audited"
            value={billsAudited.toLocaleString("en-US")}
            sub="Line-by-line"
            toneClass="border-amber-100 bg-amber-50 text-amber-900"
          />
          <Stat
            label="Plans parsed"
            value={plansParsed.toLocaleString("en-US")}
            sub="Benefits found"
            toneClass="border-purple-100 bg-purple-50 text-purple-900"
          />
        </div>
      )}

      {!loading && showMilestone && (
        <div className="mt-4 flex items-center gap-2 rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2.5">
          <svg
            className="h-4 w-4 flex-shrink-0 text-emerald-700"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 13l4 4L19 7" />
          </svg>
          <div className="text-xs text-emerald-900">
            You&apos;ve already recovered{" "}
            <strong>{formatMultiplier(multiplier)} your subscription cost</strong>.
          </div>
        </div>
      )}
    </div>
  );
}
