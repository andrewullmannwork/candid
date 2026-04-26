/**
 * MissingPlanBanner — Phase 3
 *
 * Shows when the claim's plan year has no matching insurance_plans row.
 * Routes user to the upload flow with the plan year pre-set.
 */
import Link from "next/link";

interface Props {
  claimYear: number;
  disputeId: string;
  onDismiss?: () => void;
}

export function MissingPlanBanner({ claimYear, disputeId, onDismiss }: Props) {
  const returnTo = encodeURIComponent(`/disputes?dispute=${disputeId}`);
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 shadow-sm md:flex-row md:items-center md:justify-between">
      <div className="flex-1">
        <div className="text-sm font-semibold text-amber-900">
          To strengthen this letter, add your {claimYear} insurance plan
        </div>
        <p className="mt-1 text-sm text-amber-800">
          This claim is from {claimYear} but we don&apos;t have your plan from that
          year on file. Upload your {claimYear} SBC or plan document — the letter
          will automatically include your {claimYear} benefits, copays, and
          coverage status.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Link
          href={`/upload?planYear=${claimYear}&returnTo=${returnTo}`}
          className="inline-flex items-center rounded-lg bg-amber-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-amber-700"
        >
          Upload {claimYear} plan
        </Link>
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            className="text-sm text-amber-800 underline-offset-2 hover:underline"
          >
            Dismiss
          </button>
        ) : null}
      </div>
    </div>
  );
}
