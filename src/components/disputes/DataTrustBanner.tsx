import type { DataTrustState } from "@/lib/disputes/strength-scoring";

/**
 * DataTrustBanner — readout #1 of the Block C three-axis strength model (§1a).
 *
 * Surfaces the per-bill data-trust gate from computeDisputeStrength:
 *   - "hard_stop" → red: reconciliation pending; dispute generation paused 24h.
 *   - "warn"      → amber: totals verified but uncommon format; double-check.
 *   - "pass"      → renders nothing.
 *
 * Only mounted inside the flag-ON (dispute_letter_v3_design) reskin. When the
 * gate is hard_stop AND the flag is ON the server already suppresses
 * letterContent, so this banner explains the otherwise-empty letter state.
 * Copy is locked per dispute_letter_overhaul.md §1a.
 */
export function DataTrustBanner({
  dataTrust,
}: {
  dataTrust: DataTrustState | null | undefined;
}) {
  if (!dataTrust || dataTrust.gate === "pass") return null;

  if (dataTrust.gate === "hard_stop") {
    return (
      <div
        role="status"
        title="Disputes are paused while we review this bill"
        className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3"
      >
        <div className="flex items-start gap-3">
          <WarnIcon className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-600" />
          <div>
            <div className="text-sm font-semibold text-red-900">
              Verifying this bill
            </div>
            <p className="mt-1 text-sm text-red-800">
              We noticed something unusual about this bill&apos;s totals and want
              to verify before generating a dispute. Check back in 24 hours.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // gate === "warn"
  return (
    <div
      role="status"
      className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3"
    >
      <div className="flex items-start gap-3">
        <WarnIcon className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600" />
        <div>
          <div className="text-sm font-semibold text-amber-900">
            Double-check the amounts
          </div>
          <p className="mt-1 text-sm text-amber-800">
            Heads up — this bill&apos;s format is uncommon. We&apos;ve verified
            the totals, but double-check the amounts below match your records.
          </p>
        </div>
      </div>
    </div>
  );
}

function WarnIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z"
        clipRule="evenodd"
      />
    </svg>
  );
}
