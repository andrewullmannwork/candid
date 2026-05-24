"use client";
/**
 * Cancel subscription — 3-step modal (ask → reason → done).
 *
 * Hard rule (Candid_Context "Subscription & Billing"): cancellation is
 * always period-end, never immediate. User keeps Pro through the period.
 *
 * Step 1 'ask'    — recovery-story copy + 3 bullets + Continue / Keep Pro
 * Step 2 'reason' — 5 preset reasons + free-text note; Confirm fires the
 *                   actual cancel (POST /api/stripe/cancel-subscription)
 *                   then logs the reason (POST /api/stripe/cancel-reason).
 *                   If cancel succeeds but reason log fails, we still
 *                   advance — the cancel is committed.
 * Step 3 'done'   — success card with period-end messaging.
 */

import { useEffect, useState } from "react";
import { ModalShell, SuccessModal } from "@/components/modal";
import { useAuth } from "@/lib/auth/auth-context";

const REASONS = [
  "I already recovered what I needed",
  "Too expensive",
  "Not enough plan / bill coverage",
  "Something broke",
  "Other",
];

interface CancelModalProps {
  open: boolean;
  periodEnd: string | null;
  totalRecovered: number;
  onClose: () => void;
  /** Called after the Stripe cancellation succeeds (before step 3 renders).
   *  Use this to refresh useSubscription state so /billing flips to the
   *  cancels-on plan card variant. */
  onCanceled: () => Promise<void> | void;
}

type Step = "ask" | "reason" | "done";

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

function formatCurrency(amount: number): string {
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function CancelModal({
  open,
  periodEnd,
  totalRecovered,
  onClose,
  onCanceled,
}: CancelModalProps) {
  const { user } = useAuth();
  const [step, setStep] = useState<Step>("ask");
  const [reason, setReason] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state every time the modal opens.
  useEffect(() => {
    if (open) {
      setStep("ask");
      setReason("");
      setNote("");
      setSubmitting(false);
      setError(null);
    }
  }, [open]);

  async function handleConfirmCancel() {
    if (!user || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const token = await user.firebaseUser.getIdToken();

      const cancelRes = await fetch("/api/stripe/cancel-subscription", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!cancelRes.ok) {
        const data = await cancelRes.json().catch(() => ({}));
        throw new Error(data.error || "Cancellation failed");
      }

      // Reason capture is telemetry — if it fails, we still proceed.
      if (reason) {
        try {
          await fetch("/api/stripe/cancel-reason", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ reason, note: note || undefined }),
          });
        } catch (logErr) {
          console.warn("[CancelModal] cancel-reason log failed:", logErr);
        }
      }

      await onCanceled();
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancellation failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (step === "done") {
    return (
      <SuccessModal
        open={open}
        onClose={onClose}
        title="Subscription canceled"
        subtitle="We'll miss you."
        body={
          <>
            <p className="font-semibold text-gray-900">
              You&apos;re canceled — but still on Pro until {formatDate(periodEnd)}.
            </p>
            <p className="mt-1.5 text-[13px] text-gray-600">
              Your account keeps Pro access through the end of the period. After
              that, you&apos;ll drop to Free automatically and we&apos;ll send a
              confirmation email. All your audits, disputes, and uploaded docs
              stay yours.
            </p>
          </>
        }
        primaryLabel="Got it"
        onPrimary={onClose}
      />
    );
  }

  if (step === "reason") {
    return (
      <ModalShell
        open={open}
        onClose={onClose}
        tone="default"
        size="md"
        eyebrow="Help us get better"
        title="One quick thing"
        footer={
          <>
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2.5 text-[14px] font-semibold text-gray-700 hover:bg-gray-100 rounded-xl transition-colors disabled:opacity-50"
            >
              Never mind
            </button>
            <button
              type="button"
              onClick={handleConfirmCancel}
              disabled={!reason || submitting}
              className="px-4 py-2.5 text-[14px] font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition-colors disabled:cursor-not-allowed disabled:bg-blue-300"
            >
              {submitting ? "Canceling…" : "Confirm cancellation"}
            </button>
          </>
        }
      >
        <p className="text-[14px] text-gray-700">
          Why are you canceling? We read every answer.
        </p>
        <div className="mt-3 space-y-1.5">
          {REASONS.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setReason(r)}
              className={`flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left text-sm transition-colors ${
                reason === r
                  ? "border-blue-300 bg-blue-50 text-blue-900"
                  : "border-gray-200 bg-white text-gray-700 hover:border-gray-300"
              }`}
            >
              <span
                className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border-2 ${
                  reason === r ? "border-blue-600" : "border-gray-300"
                }`}
              >
                {reason === r && (
                  <span className="h-1.5 w-1.5 rounded-full bg-blue-600" />
                )}
              </span>
              {r}
            </button>
          ))}
        </div>
        <div className="mt-3">
          <label className="mb-1 block text-[12px] font-medium text-gray-700">
            Anything else? (optional)
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What would have made Candid worth it?"
            rows={3}
            className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
          />
        </div>
        {error && (
          <p className="mt-3 rounded-lg border border-red-100 bg-red-50 p-2 text-xs text-red-700">
            {error}
          </p>
        )}
      </ModalShell>
    );
  }

  // step === "ask"
  return (
    <ModalShell
      open={open}
      onClose={onClose}
      tone="default"
      size="md"
      eyebrow="Before you go"
      title="Cancel your subscription?"
      footer={
        <>
          <button
            type="button"
            onClick={() => setStep("reason")}
            className="px-4 py-2.5 text-[14px] font-semibold text-red-700 hover:bg-red-50 rounded-xl transition-colors"
          >
            Continue canceling
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2.5 text-[14px] font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition-colors"
          >
            Keep Pro
          </button>
        </>
      }
    >
      {totalRecovered > 0 ? (
        <p className="text-[14px] text-gray-700">
          You&apos;ve recovered <strong>{formatCurrency(totalRecovered)}</strong>{" "}
          with Candid Pro. If you cancel today:
        </p>
      ) : (
        <p className="text-[14px] text-gray-700">If you cancel today:</p>
      )}
      <ul className="mt-3 space-y-2 text-[13px] text-gray-700">
        <li className="flex items-start gap-2">
          <svg
            className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-emerald-600"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 13l4 4L19 7" />
          </svg>
          You keep Pro until <strong>{formatDate(periodEnd)}</strong> (no refund needed).
        </li>
        <li className="flex items-start gap-2">
          <svg
            className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-emerald-600"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 13l4 4L19 7" />
          </svg>
          Your audits, disputes, and uploaded documents stay yours.
        </li>
        <li className="flex items-start gap-2">
          <svg
            className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-gray-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
          You&apos;ll lose unlimited audits, new dispute drafting, and bundle support.
        </li>
      </ul>
    </ModalShell>
  );
}
