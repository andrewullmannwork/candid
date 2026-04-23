"use client";

/**
 * Cancel Subscription Dialog — confirmation modal for /billing's Cancel CTA.
 *
 * Hard rule (Candid_Context "Subscription & Billing"): cancellation is always
 * period-end, never immediate. User keeps Pro until the current renewal
 * date, then automatically drops to Free.
 */

import { useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";

export interface CancelSubscriptionDialogProps {
  isOpen: boolean;
  periodEnd: string | null;
  onConfirmed: () => void;
  onCancel: () => void;
}

function formatDate(iso: string | null): string {
  if (!iso) return "your next renewal";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

export function CancelSubscriptionDialog({
  isOpen,
  periodEnd,
  onConfirmed,
  onCancel,
}: CancelSubscriptionDialogProps) {
  const { user } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  async function handleConfirm() {
    if (!user) return;
    setSubmitting(true);
    setError(null);
    try {
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/stripe/cancel-subscription", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Cancellation failed");
      }
      onConfirmed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancellation failed");
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 p-4">
      <div className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <button
          type="button"
          onClick={onCancel}
          aria-label="Close"
          className="absolute right-3 top-3 rounded-full p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <h2 className="text-lg font-bold text-gray-900">Cancel Candid Pro?</h2>
        <p className="mt-2 text-sm text-gray-600">
          You&apos;ll keep Pro until {formatDate(periodEnd)}, then automatically drop to Free.
          You can resume anytime before then to stay on Pro.
        </p>

        <ul className="mt-4 space-y-1.5 text-xs text-gray-600">
          <li>• You&apos;ll lose access to dispute letter generation</li>
          <li>• The lawyer directory will lock</li>
          <li>• Community pricing (Candid Care) will lock</li>
          <li>• Your uploaded documents and audit history stay intact</li>
        </ul>

        {error && (
          <p className="mt-4 rounded-lg border border-red-100 bg-red-50 p-2 text-xs text-red-700">
            {error}
          </p>
        )}

        <div className="mt-5 flex items-center gap-2">
          <button
            type="button"
            onClick={handleConfirm}
            disabled={submitting}
            className="flex-1 rounded-xl bg-red-600 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-red-300"
          >
            {submitting ? "Canceling…" : "Confirm cancellation"}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="px-4 py-2.5 text-sm font-medium text-gray-600 hover:text-gray-800 disabled:text-gray-300"
          >
            Keep Pro
          </button>
        </div>
      </div>
    </div>
  );
}
