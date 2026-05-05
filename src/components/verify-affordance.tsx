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
  /** Optional callback when re-parse succeeds — parent can update its own state. */
  onReparseSuccess?: (decoratedValue: DecoratedValue<unknown>, finalVerifiedState: string) => void;
}

const SBC_NON_DO_NOT_EXTRACT_SECTION_COUNT = 5;

function reasonMessage(reason: DisplayStateReason): string {
  switch (reason) {
    case "haiku_not_found":
      return "We extracted this value but couldn't find a matching quote in your document.";
    case "verbatim_absent_searched_all":
      return "We searched your entire plan document and couldn't find a verbatim quote for this value. A more complete plan document (full EOC, not just an SBC) may have it.";
    case "ocr_unverifiable":
      return "Pulled from a scanned document — wording couldn't be fully verified.";
    case "canonical_fallback":
      return "Estimated from public marketplace data.";
    case "cross_user_below_threshold":
      return "Sourced from other Candid users on this plan; still gathering enough confirmations.";
    case "self_source_no_cite":
      return "Based on your uploaded document. Couldn't find a verbatim citation.";
    case "low_confidence":
      return "Best estimate — the parser wasn't very confident here.";
    case "p8_cite_grade_corroborated":
    case "p8_cite_grade_self_source":
    case "corroborated_multi_user":
    case "do_not_extract_section":
      return "We have this value but couldn't find a verbatim citation in your plan documents.";
    default:
      return "We have this value but couldn't find a verbatim citation in your plan documents.";
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
  onReparseSuccess,
}: VerifyAffordanceProps) {
  const [pending, startTransition] = useTransition();
  const [optimisticState, setOptimisticState] = useState<DisplayState | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [reparseInflight, setReparseInflight] = useState(false);
  const router = useRouter();

  const effectiveState = optimisticState ?? state;
  // CF-19 (Session 64) — 6-state vocabulary: any of the 3 verified-tier states
  // (candid_verified / document_verified / found_in_document) means we have enough
  // signal that we don't need the verify-affordance prompt; user can take action
  // via the doc upload flow if they want stronger evidence.
  if (
    effectiveState === "candid_verified" ||
    effectiveState === "document_verified" ||
    effectiveState === "found_in_document" ||
    effectiveState === "hidden"
  ) {
    return null;
  }

  // Determine whether the "Re-check our analysis" button should appear.
  // Conditions (all required):
  //   - reason is haiku_not_found (verbatim_absent has different UX — no re-check)
  //   - planId + fieldName provided by caller
  //   - searchedSectionsCount is defined AND incomplete (< 5)
  // Pre-Phase-4.0.5 rows (searched_sections undefined) fall back to single-link
  // per Q-P4.0.5-7 LOCK forward-only commitment.
  const reparseCallable =
    reason === "haiku_not_found" &&
    planId !== undefined &&
    fieldName !== undefined &&
    searchedSectionsCount !== undefined &&
    searchedSectionsCount > 0 &&
    searchedSectionsCount < SBC_NON_DO_NOT_EXTRACT_SECTION_COUNT;

  async function handleReparse() {
    if (!planId || !fieldName) return;
    setReparseInflight(true);
    setToast(null);
    setOptimisticState("estimated"); // intermediate state — pending verification result
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

  const message = reasonMessage(reason);
  const ocrUnverifiableLabel = reason === "ocr_unverifiable";
  const linkLabel = ocrUnverifiableLabel
    ? "Upload a clearer scan"
    : "Upload a different plan document";

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
  // CF-19 (Session 64): any of the 3 verified-tier states has enough signal —
  // user can take action via doc upload if they want stronger evidence; no inline prompt.
  // Note: verbatim_absent_searched_all is now found_in_document state, NOT unverified —
  // but the affordance routing still wants to show a one_button "upload more complete doc"
  // prompt for it. Special-cased below (state-agnostic on reason).
  if (
    opts.state === "candid_verified" ||
    opts.state === "document_verified" ||
    opts.state === "found_in_document" ||
    opts.state === "hidden"
  ) {
    // Exception: found_in_document via verbatim_absent_searched_all — still surface
    // the one-button upload prompt because user can resolve the gap with a fuller doc.
    if (opts.state === "found_in_document" && opts.reason === "verbatim_absent_searched_all") {
      return "one_button_upload";
    }
    return null;
  }
  if (opts.reason === "verbatim_absent_searched_all") return "one_button_upload";
  if (opts.reason === "haiku_not_found") {
    const c = opts.searchedSectionsCount;
    if (c === undefined || c === 0) return "single_link";
    if (c >= SBC_NON_DO_NOT_EXTRACT_SECTION_COUNT) return "one_button_upload";
    return "two_button";
  }
  return "single_link";
}
