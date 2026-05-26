/**
 * B3.3 — Results-view header for /compare.
 *
 * "Your comparison · {N} plans side-by-side · scan for the green BEST badges"
 * with a Start over button on the right. Matches §1.C.3 design recommendation
 * 2 (results topbar block).
 */

interface CompareTopbarProps {
  planCount: number;
  onStartOver: () => void;
}

export function CompareTopbar({ planCount, onStartOver }: CompareTopbarProps) {
  return (
    <div className="flex items-start justify-between gap-4 mb-8">
      <div className="min-w-0">
        <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">
          Your comparison
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {planCount} plan{planCount === 1 ? "" : "s"} side-by-side · scan for the green{" "}
          <span className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-emerald-100 text-emerald-800 text-[10px] font-bold uppercase tracking-wide leading-none ring-1 ring-emerald-200">
            Best
          </span>{" "}
          badges
        </p>
      </div>
      <button
        type="button"
        onClick={onStartOver}
        className="shrink-0 text-sm font-semibold text-blue-600 hover:text-blue-700"
      >
        ← Start over
      </button>
    </div>
  );
}
