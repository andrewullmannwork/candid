"use client";

/**
 * Phase 4.0.5 Task 4.0.5-F — Smart 2-button VerifyAffordance.
 *
 * Replaces Phase 4.0's single-link "Upload a more complete plan document"
 * affordance with a state-matrix-aware affordance:
 *
 *   - `verbatim_absent_searched_all`: 1-button "Upload a different plan document"
 *     (deterministic — re-parse won't help; user needs different/more complete doc).
 *   - `haiku_not_found` + searched_sections covers all: same as verbatim_absent
 *     (defensive fallback when verifier post-pass didn't fire for some reason).
 *   - `haiku_not_found` + searched_sections incomplete: 2-button "Re-check our
 *     analysis" + "Upload different doc". Re-check calls /api/plan/reparse-field
 *     to dispatch Haiku on un-searched sections; optimistic UI swap on 200; toast
 *     on 429 / 5xx; falls back to single-link if searched_sections is undefined
 *     (forward-only per Q-P4.0.5-7 LOCK).
 *   - `canonical_fallback` / `cross_user_below_threshold` / `ocr_unverifiable`:
 *     existing single-link copy unchanged from Phase 4.0.
 *
 * Layout shape stable from Phase 4.0 — same amber-bordered card slot. Buttons
 * sit where the link was; collapsed row still shows pill only.
 *
 * Re-export shim from `src/components/display-state.tsx` keeps existing imports
 * (`import { VerifyAffordance } from "@/components/display-state"`) working.
 */

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { needsUploadCTA } from "@/lib/parser/consumer-read";
import type {
  DecoratedValue,
  DisplayState,
  DisplayStateReason,
} from "@/lib/parser/consumer-read";

interface VerifyAffordanceProps {
  state: DisplayState;
  reason: DisplayStateReason;
  /** Optional override URL for the upload-different-doc link. Defaults to /upload. */
  uploadHref?: string;
  /** Plan ID for re-parse fetch. Required to surface "Re-check our analysis" button. */
  planId?: string;
  /** Field column name (e.g., "in_deductible_individual"). Required for re-parse. */
  fieldName?: string;
  /** Service slug for plan_covered_services row re-parse. Omit for insurance_plans. */
  serviceSlug?: string;
  /** Coverage of all SBC non-DO_NOT_EXTRACT sections (5 total). When 5 of 5 OR
   *  when undefined (forward-only fallback per Q-P4.0.5-7), the 2-button affordance
   *  is suppressed in favor of single-link upload-different-doc. */
  searchedSectionsCount?: number;
  /** S71.5-BADGE-VERIFY (Session 74): when true, the user has an active SBC or
   *  plan_doc upload — copy reads "Upload a more complete plan document" so the
   *  prompt acknowledges they already uploaded. When false/undefined, cold-start
   *  framing "Upload your plan document". Codified in [[Candid_10k]] §3.1
   *  Display State Achievement & Graduation Rules §8 (page-level prompt rule). */
  userHasDoc?: boolean;
  /** Optional callback when re-parse succeeds — parent can update its own state. */
  onReparseSuccess?: (decoratedValue: DecoratedValue<unknown>, finalVerifiedState: string) => void;
}

// SBC_NON_DO_NOT_EXTRACT_SECTION_COUNT was used by the pre-CF-19-v2 two_button affordance
// routing for haiku_not_found re-check eligibility. CF-19 v2 collapses re-parse out of the
// inline affordance — moves to dispute-letter generation flow per CF-20 (Session 65). Constant
// retained as 5 for documentation; unused at runtime now.

function reasonMessage(reason: DisplayStateReason, userHasDoc: boolean | undefined): string {
  // CF-19 v2 (Session 64): Estimated reasons all encourage doc upload. Tooltip-text
  // distinction kept lightweight — backend reason routes to message; user sees one
  // upload CTA regardless.
  // S71.5-BADGE-VERIFY (Session 74): when userHasDoc is true, copy acknowledges
  // the user already uploaded — "your document didn't include this field" instead
  // of cold-start framing. Codified in Candid_10k §3.1 graduation rules §9.
  switch (reason) {
    case "canonical_below_threshold":
      return userHasDoc
        ? "Other Candid users on this plan reported a value here, but your document didn't include it."
        : "We have data on this plan from other Candid users, but we're still gathering confirmations.";
    case "cms_marketplace":
      return userHasDoc
        ? "This is a public-marketplace estimate — your uploaded document didn't include this field."
        : "Estimated from public CMS marketplace data based on your insurance card.";
    case "provider_attestation_below_threshold":
      return "Estimated from provider-reported data; still being verified.";
    default:
      return userHasDoc
        ? "Your uploaded document didn't include this field."
        : "We're estimating this value. Upload your plan document for the real story.";
  }
}

export function VerifyAffordance({
  state,
  reason,
  uploadHref = "/upload",
  planId,
  fieldName,
  serviceSlug,
  searchedSectionsCount,
  userHasDoc,
  onReparseSuccess,
}: VerifyAffordanceProps) {
  const [pending, startTransition] = useTransition();
  const [optimisticState, setOptimisticState] = useState<DisplayState | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [reparseInflight, setReparseInflight] = useState(false);
  const router = useRouter();

  const effectiveState = optimisticState ?? state;
  // Session 72 v2: only Community + Public Data show the inline upload affordance
  // (i.e., needsUploadCTA() — values where uploading the user's doc would improve
  // the signal). Verified / Upload / User Verified are trusted; Hidden surfaces
  // via the page-level banner instead.
  if (!needsUploadCTA(effectiveState)) return null;

  // CF-20 (Session 65 fast-follow): re-parse-on-flag for dispute-letter cite-grade
  // deferred. The PR #39 inline re-parse button (haiku_not_found) is now hidden by
  // default for Estimated state; re-parse moves to dispute-letter generation flow.
  // Suppress the button entirely for Estimated rows; only show the upload CTA.
  const reparseCallable = false;
  void planId;
  void fieldName;
  void serviceSlug;
  void searchedSectionsCount;

  async function handleReparse() {
    if (!planId || !fieldName) return;
    setReparseInflight(true);
    setToast(null);
    setOptimisticState("community"); // intermediate state — pending verification result
    try {
      const res = await fetch("/api/plan/reparse-field", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Auth header attached by middleware / server client; this is a same-origin
          // call so cookie-based auth applies.
        },
        body: JSON.stringify({ planId, fieldName, serviceSlug }),
        credentials: "same-origin",
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: "unknown" }));
        if (res.status === 429) {
          if (errBody.error === "rate_limit_exceeded") {
            setToast("Re-check rate limit reached. Please wait a moment and try again.");
          } else if (errBody.error === "daily_cap_exceeded") {
            setToast("Re-check limit reached for today. Try again tomorrow.");
          } else {
            setToast("Re-check cost limit reached. Try uploading a different document.");
          }
        } else if (res.status === 409) {
          if (errBody.error === "no_unsearched_sections") {
            setToast("All sections already searched — try uploading a different plan document.");
          } else {
            setToast("This document doesn't support re-checking. Try uploading a different one.");
          }
        } else {
          setToast("Re-check failed. Please try again later.");
        }
        setOptimisticState(null);
        return;
      }
      const data = (await res.json()) as {
        success: boolean;
        decoratedValue?: DecoratedValue<unknown>;
        finalVerifiedState?: string;
      };
      if (data.success && data.decoratedValue) {
        setOptimisticState(data.decoratedValue.state);
        if (onReparseSuccess) {
          onReparseSuccess(data.decoratedValue, data.finalVerifiedState ?? "not_found");
        }
        // Trigger background revalidation so server-rendered page reflects the
        // updated field_provenance + cross-field state changes (Q-P4.0.5-6 hybrid).
        startTransition(() => {
          router.refresh();
        });
      } else {
        setOptimisticState(null);
        setToast("Re-check returned no result. Try uploading a different document.");
      }
    } catch (err) {
      console.error("[verify-affordance] re-parse fetch failed:", err);
      setOptimisticState(null);
      setToast("Re-check failed. Please try again later.");
    } finally {
      setReparseInflight(false);
    }
  }

  const message = reasonMessage(reason, userHasDoc);
  // S71.5-BADGE-VERIFY (Session 74): cold-start vs already-uploaded framing.
  // Codified in [[Candid_10k]] §3.1 Display State Achievement & Graduation Rules §9.
  const linkLabel = userHasDoc
    ? "Upload a more complete plan document"
    : "Upload your plan document";

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3">
      <p className="text-xs text-amber-900">
        <span className="font-semibold">Want to verify this?</span> {message}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {reparseCallable && (
          <button
            type="button"
            onClick={handleReparse}
            disabled={reparseInflight || pending}
            className="inline-flex items-center gap-1 rounded-md bg-amber-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-60"
          >
            {reparseInflight || pending ? (
              <>
                <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                Re-checking…
              </>
            ) : (
              "Re-check our analysis"
            )}
          </button>
        )}
        <Link
          href={uploadHref}
          className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700 hover:text-amber-900"
        >
          {linkLabel}
          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </Link>
      </div>
      {toast && (
        <p className="mt-2 text-[11px] text-amber-700" role="status">
          {toast}
        </p>
      )}
    </div>
  );
}

/**
 * Pure routing function for smoke-test C12 (no React; deterministic mapping).
 * Returns "two_button" / "one_button_recheck_disabled" / "one_button_upload" / "single_link" / null.
 *
 * Mirror of the runtime branching above:
 *   - state=verified|hidden → null
 *   - reason=haiku_not_found AND searched_sections incomplete (>0 AND <5) → "two_button"
 *   - reason=haiku_not_found AND searched_sections complete (===5) → "one_button_upload" (re-check N/A)
 *   - reason=haiku_not_found AND searched_sections undefined OR 0 → "single_link" (forward-only)
 *   - reason=verbatim_absent_searched_all → "one_button_upload"
 *   - reason=ocr_unverifiable → "single_link" (re-OCR deferred to Phase 6)
 *   - other reasons (canonical_fallback, etc.) → "single_link"
 */
export type AffordanceShape =
  | "two_button"
  | "one_button_upload"
  | "single_link"
  | null;

export function affordanceShapeFor(opts: {
  state: DisplayState;
  reason: DisplayStateReason;
  searchedSectionsCount: number | undefined;
}): AffordanceShape {
  // Session 72 v2: only Community + Public Data trigger the inline upload affordance.
  // Verified / Upload / User Verified don't need a prompt — user trusts them.
  // Hidden (parser_failure / boilerplate) handled by the page-level error banner.
  if (!needsUploadCTA(opts.state)) return null;
  // Community + Public Data: single one-button-upload affordance ("Upload your plan
  // document"). Backend reasons all share the same UX path: encourage user to upload
  // SBC for the real story.
  void opts.reason;
  void opts.searchedSectionsCount;
  return "one_button_upload";
}
