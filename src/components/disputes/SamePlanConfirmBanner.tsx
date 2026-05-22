"use client";

/**
 * SamePlanConfirmBanner — S109 PR #2 (Chunk B).
 *
 * Renders above the dispute letter on the /disputes view when the user has a
 * fallback plan on file (different year than the bill) and hasn't yet
 * confirmed whether they were on the same insurer in the bill year. The
 * answer drives whether the letter renders Case C-fallback (cite current
 * plan as proxy + reverse-burden on insurer) or Case D (safe framing only).
 *
 * Three-state UX per plans/s109_dispute_letter_lawyer_posture.md §3:
 *   [Yes, same insurer]   → cite current plan as proxy (Case C-fallback)
 *                            + offer Upload-current-year-plan as stronger evidence
 *   [No, different insurer] → safe framing (Case D)
 *                            + offer Upload-bill-year-plan
 *                            + (Chunk D) Find-in-Candid-library search modal
 *   [Not sure]            → safe framing (Case D)
 *
 * Once an answer is recorded, the banner hides and the letter regenerates.
 * Per Andrew's direction this component is functional-baseline; Claude
 * Design will polish visuals before merge.
 */

import { useState } from "react";

export interface SamePlanConfirmBannerProps {
  disputeId: string;
  /** Bill year derived from claim.plan_year or date_of_service in the resolver. */
  billYear: number;
  /** Fallback plan's year — when known, shown as context ("Your 2025 plan…"). */
  fallbackPlanYear: number | null;
  /** Insurer name from planContext, shown as context ("…the same Cigna plan…"). */
  insurerName: string | null;
  /** Current persisted answer; banner hides when this is non-null. */
  currentAnswer: "yes" | "no" | "not_sure" | null;
  /** Firebase bearer token getter (passed in by parent so this component
   *  stays auth-agnostic — matches the pattern used by InsurerAddressCorrectionModal). */
  getAuthToken: () => Promise<string | null>;
  /** Called after a successful confirm; parent re-fetches the dispute so the
   *  letter regenerates with the new framing. */
  onConfirmed: (answer: "yes" | "no" | "not_sure") => void;
}

export function SamePlanConfirmBanner({
  disputeId,
  billYear,
  fallbackPlanYear,
  insurerName,
  currentAnswer,
  getAuthToken,
  onConfirmed,
}: SamePlanConfirmBannerProps) {
  const [submitting, setSubmitting] = useState<"yes" | "no" | "not_sure" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Already answered → hide banner. Parent decides re-show via state reset
  // (e.g., after upload that adds bill-year plan).
  if (currentAnswer != null) return null;

  async function submit(answer: "yes" | "no" | "not_sure") {
    if (submitting) return;
    setSubmitting(answer);
    setError(null);
    try {
      const token = await getAuthToken();
      if (!token) throw new Error("Sign-in expired. Please reload and try again.");
      const res = await fetch(`/api/disputes/${disputeId}/confirm-same-plan`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ answer }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `confirm failed (${res.status})`);
      }
      onConfirmed(answer);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save your answer");
    } finally {
      setSubmitting(null);
    }
  }

  const insurerClause = insurerName ? `the same ${insurerName} plan` : "the same insurer";
  const fbYearClause = fallbackPlanYear != null
    ? ` Your ${fallbackPlanYear} plan is on file.`
    : "";

  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50/70 px-4 py-4">
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-blue-900">
            Were you on {insurerClause} in {billYear}?
          </h3>
          <p className="mt-1 text-xs text-blue-800/90 leading-relaxed">
            We don&apos;t have your {billYear} plan on file.{fbYearClause} If
            you had the same insurer in {billYear}, this letter can cite your
            current plan&apos;s terms as a proxy and require the insurer to
            prove any year-over-year differences. If you switched insurers,
            those terms don&apos;t apply and we&apos;ll fall back to a safer
            framing that leans on statutory rights only.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => submit("yes")}
            disabled={submitting != null}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed"
          >
            {submitting === "yes" ? "Saving…" : `Yes, same insurer in ${billYear}`}
          </button>
          <button
            type="button"
            onClick={() => submit("no")}
            disabled={submitting != null}
            className="rounded-lg border border-blue-300 bg-white px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting === "no" ? "Saving…" : "No, different insurer"}
          </button>
          <button
            type="button"
            onClick={() => submit("not_sure")}
            disabled={submitting != null}
            className="rounded-lg border border-blue-200 bg-transparent px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting === "not_sure" ? "Saving…" : "Not sure"}
          </button>
        </div>

        {error && (
          <div className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
