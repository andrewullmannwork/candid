/**
 * UploadPlanDocModal — S135 PR-3.
 *
 * Opens when a user clicks on a `not_covered` row's coverage badge or "Your
 * pick" pill. Per Andrew's S135 direction: re-editing a `not_covered` line
 * shouldn't surface the dropdown picker again (their first pick already
 * landed off-plan; re-picking the same catalog won't help). The next help
 * we can offer is fresher plan data — route them to plan-doc upload.
 *
 * NO dropdown. NO re-pick path. Upload OR close.
 */
"use client";

import Link from "next/link";

interface Props {
  open: boolean;
  description: string | null;
  billingCode: string | null;
  onClose: () => void;
}

export function UploadPlanDocModal({
  open,
  description,
  billingCode,
  onClose,
}: Props) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="upload-plan-doc-title"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-start justify-between">
          <h2 id="upload-plan-doc-title" className="text-lg font-semibold text-gray-900">
            Update your plan coverage
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="mb-4 rounded border border-gray-200 bg-gray-50 p-3 text-sm">
          <div className="font-medium text-gray-900">{description || "Line item"}</div>
          {billingCode && (
            <div className="text-gray-600">Code: {billingCode}</div>
          )}
        </div>

        <p className="mb-4 text-sm text-gray-700">
          We don&apos;t see this service in your plan data. Upload your full plan
          document so we can verify what&apos;s covered and recompute this bill
          correctly.
        </p>

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Close
          </button>
          <Link
            href="/upload"
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
          >
            Upload plan document
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        </div>
      </div>
    </div>
  );
}
