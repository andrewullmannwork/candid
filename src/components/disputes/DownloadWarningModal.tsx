/**
 * DownloadWarningModal — Phase 3
 *
 * Shown when the user clicks "Download Case File" but their plan for the
 * claim year isn't on file. Warn-not-block per user decision (2026-04-22).
 */
import Link from "next/link";

interface Props {
  open: boolean;
  claimYear: number;
  disputeId: string;
  onCancel: () => void;
  onDownloadAnyway: () => void;
}

export function DownloadWarningModal({
  open,
  claimYear,
  disputeId,
  onCancel,
  onDownloadAnyway,
}: Props) {
  if (!open) return null;
  const returnTo = encodeURIComponent(`/disputes?dispute=${disputeId}`);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <div className="text-lg font-semibold text-slate-900">
          Your {claimYear} plan isn&apos;t on file yet
        </div>
        <p className="mt-2 text-sm text-slate-600">
          This Case File will be more persuasive with your {claimYear} plan document.
          Copays, coverage status, and the &ldquo;Why this should be covered&rdquo; analysis
          will be generic without it.
        </p>
        <div className="mt-5 flex flex-col-reverse gap-2 md:flex-row md:justify-end">
          <button
            type="button"
            onClick={onDownloadAnyway}
            className="inline-flex items-center justify-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Download anyway
          </button>
          <Link
            href={`/upload?planYear=${claimYear}&returnTo=${returnTo}`}
            onClick={onCancel}
            className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700"
          >
            Upload {claimYear} plan instead
          </Link>
        </div>
      </div>
    </div>
  );
}
