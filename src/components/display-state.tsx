/**
 * Phase 4 Task 4-C — display-state UI primitives.
 *
 * Three components, ranked by visual weight:
 *
 *   <DisplayStateBadge>  — small color-coded pill that signals "can I trust this number?"
 *                          Always-visible per Q-DR-4C-1 = (A) LOCK. Renders nothing
 *                          for state="hidden" so callers don't need to branch.
 *
 *   <SourceQuote>        — gold-standard treatment for case 1 (cite-grade verified):
 *                          renders the verbatim source_excerpt with an emerald-tinted
 *                          "Verified from your plan document" caption. Q-DR-4E-2 LOCK
 *                          case 1 emphasis ("gold standard level signal").
 *
 *   <VerifyAffordance>   — call-to-action for non-verified states. Phase 4.0 ships
 *                          a single "Upload a more complete plan document" link.
 *                          Phase 4.0.5 will swap this for the smart 2-button affordance
 *                          ("Re-check our analysis" vs "Upload different doc") once
 *                          section-coverage tracking enables verbatim_absent derivation.
 *                          Layout is forward-compatible — Phase 4.0.5 replaces the
 *                          link with two buttons in the same slot.
 *
 * Type guard:
 *   isDecoratedValue<T>(v) — at the boundary between API response and UI render.
 *                          When `consumer_read_filter_v1` flag is OFF, the API returns
 *                          raw T (legacy shape). When ON, returns DecoratedValue<T>
 *                          with state + reason + excerpt metadata. UI uses this guard
 *                          to detect which shape is in hand without threading flag
 *                          state through every render path.
 */
import type { DecoratedValue, DisplayState, DisplayStateReason } from "@/lib/parser/consumer-read";
import {
  DISPLAY_STATE_TOOLTIP_EN,
  isDecoratedValue,
  aggregateRowState,
} from "@/lib/parser/consumer-read";
// Phase 4.0.5 Task 4.0.5-F: smart 2-button affordance moved to dedicated Client
// Component file. Re-export from here preserves existing imports across the codebase
// (`import { VerifyAffordance } from "@/components/display-state"`).
import { VerifyAffordance } from "@/components/verify-affordance";

export { isDecoratedValue, aggregateRowState, VerifyAffordance };
export type { DecoratedValue, DisplayState, DisplayStateReason };

/**
 * Unwrap a `T | DecoratedValue<T>` to the raw T. Used wherever a render path needs
 * the underlying value but doesn't need state metadata.
 */
export function unwrapValue<T>(v: T | DecoratedValue<T> | null | undefined): T | null {
  if (v == null) return null;
  if (isDecoratedValue<T>(v)) return v.value;
  return v as T;
}

/**
 * Normalize a `T | DecoratedValue<T>` into a uniform shape for render branching.
 * Returns `{value, state, reason, excerpt}` with state=null for raw (flag-OFF) values.
 *
 * Render pattern:
 *   const { value, state, reason, excerpt } = decoratedShape(planSummary?.inDeductible);
 *   ${value != null ? formatUsd(value) : "—"}
 *   {state && <DisplayStateBadge state={state} reason={reason!} />}
 */
export function decoratedShape<T>(v: T | DecoratedValue<T> | null | undefined): {
  value: T | null;
  state: DisplayState | null;
  reason: DisplayStateReason | null;
  excerpt: string | null;
  hasExcerpt: boolean;
  searchedSectionsCount: number | undefined;
} {
  if (v == null) {
    return {
      value: null,
      state: null,
      reason: null,
      excerpt: null,
      hasExcerpt: false,
      searchedSectionsCount: undefined,
    };
  }
  if (isDecoratedValue<T>(v)) {
    return {
      value: v.value,
      state: v.state,
      reason: v.reason,
      excerpt: v.excerpt,
      hasExcerpt: v.hasExcerpt,
      searchedSectionsCount: v.searchedSectionsCount,
    };
  }
  return {
    value: v as T,
    state: null,
    reason: null,
    excerpt: null,
    hasExcerpt: false,
    searchedSectionsCount: undefined,
  };
}

// `aggregateRowState` lives in consumer-read.ts and is re-exported above so smoke
// tests can exercise it without React imports.

interface BadgeStyle {
  bg: string;
  text: string;
  ring: string;
  label: string;
  icon: React.ReactNode;
}

// CF-19 (Session 64) — 6-state visual treatment per user direction.
//   candid_verified    → fully green (filled emerald) — Pattern 1 #3 corroboration met
//   document_verified  → dark green border (border-2 emerald) — Pattern P-8 cite-grade from THIS user's doc
//   found_in_document  → light green border (border-1 light emerald) — extracted from doc; verbatim absent
//   estimated          → amber pill (existing)
//   unverified         → rose pill (existing)
//   hidden             → no render

const CHECKMARK_ICON = (
  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
  </svg>
);

const DOC_ICON = (
  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
  </svg>
);

const CANDID_VERIFIED_STYLE: BadgeStyle = {
  bg: "bg-emerald-600",
  text: "text-white",
  ring: "ring-emerald-700",
  label: "Candid Verified",
  icon: CHECKMARK_ICON,
};

const DOCUMENT_VERIFIED_STYLE: BadgeStyle = {
  bg: "bg-emerald-50",
  text: "text-emerald-700",
  ring: "ring-emerald-400",
  label: "Document Verified",
  icon: CHECKMARK_ICON,
};

const FOUND_IN_DOCUMENT_STYLE: BadgeStyle = {
  bg: "bg-emerald-50/60",
  text: "text-emerald-600",
  ring: "ring-emerald-200",
  label: "Found in Document",
  icon: DOC_ICON,
};

const ESTIMATED_STYLE: BadgeStyle = {
  bg: "bg-amber-50",
  text: "text-amber-700",
  ring: "ring-amber-200",
  label: "Estimated",
  icon: (
    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="6" />
    </svg>
  ),
};

const UNVERIFIED_STYLE: BadgeStyle = {
  bg: "bg-rose-50",
  text: "text-rose-700",
  ring: "ring-rose-200",
  label: "Unverified",
  icon: (
    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M12 21a9 9 0 110-18 9 9 0 010 18z" />
    </svg>
  ),
};

function styleFor(state: DisplayState): BadgeStyle | null {
  if (state === "candid_verified") return CANDID_VERIFIED_STYLE;
  if (state === "document_verified") return DOCUMENT_VERIFIED_STYLE;
  if (state === "found_in_document") return FOUND_IN_DOCUMENT_STYLE;
  if (state === "estimated") return ESTIMATED_STYLE;
  if (state === "unverified") return UNVERIFIED_STYLE;
  return null; // "hidden" → component returns null upstream
}

interface DisplayStateBadgeProps {
  state: DisplayState;
  reason: DisplayStateReason;
  /** Compact pill (text-[10px], px-1.5) for dense surfaces; default text-xs px-2 for plan summary. */
  size?: "xs" | "sm";
  /** Override default tooltip text (for surfaces that need surface-specific framing). */
  tooltip?: string;
}

export function DisplayStateBadge({
  state,
  reason,
  size = "sm",
  tooltip,
}: DisplayStateBadgeProps) {
  if (state === "hidden") return null;
  const style = styleFor(state);
  if (!style) return null;
  const tipText = tooltip ?? DISPLAY_STATE_TOOLTIP_EN[reason];
  const sizing =
    size === "xs"
      ? "text-[10px] px-1.5 py-0.5 gap-0.5"
      : "text-xs px-2 py-0.5 gap-1";
  return (
    <span
      title={tipText}
      className={`inline-flex items-center font-semibold rounded-full ring-1 ${sizing} ${style.bg} ${style.text} ${style.ring}`}
    >
      {style.icon}
      {style.label}
    </span>
  );
}

interface SourceQuoteProps {
  /** Verbatim text from the user's plan document. */
  excerpt: string;
  /** Optional caption suffix — e.g., "your SBC, page 3". Defaults to "your plan document". */
  source?: string;
}

/**
 * Gold-standard treatment for cite-grade verified fields. Renders the Pattern P-8
 * source_excerpt as an emerald-tinted blockquote with a "Verified from..." caption.
 *
 * Caller responsibility: only render this when state === "verified" AND
 * `decorated.hasExcerpt` AND `decorated.excerpt` is non-empty. The component does
 * NOT no-op gracefully on missing excerpt — it would render an empty quote which
 * is worse than nothing. Branch upstream.
 */
export function SourceQuote({ excerpt, source = "your plan document" }: SourceQuoteProps) {
  return (
    <div className="rounded-xl border-l-4 border-emerald-300 bg-emerald-50/60 px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 flex items-center gap-1">
        <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
        Verified from {source}
      </p>
      <blockquote className="mt-1.5 text-sm italic text-slate-700 leading-relaxed">
        &ldquo;{excerpt.trim()}&rdquo;
      </blockquote>
    </div>
  );
}

// Phase 4.0.5: VerifyAffordance moved to src/components/verify-affordance.tsx
// (Client Component for onClick handler). Re-export above preserves callers.
