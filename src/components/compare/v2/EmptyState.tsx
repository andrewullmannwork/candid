"use client";

import { cn } from "@/lib/utils/cn";

/**
 * Compare v2 (S157, PR2) — distinct empty-state treatments for service cells.
 *
 * The single most important comprehension upgrade in the reskin: three visually
 * distinct "no value" treatments, because they mean very different things to a
 * member (compare_v2_redesign.md §4.3 + design README "Distinct empty states"):
 *
 *   • na  (Not applicable) — the plan STRUCTURALLY has no such benefit (e.g. an
 *          HMO/EPO with no out-of-network coverage). Neutral grey. The concept
 *          doesn't apply. Fires ONLY on a positive structural signal (see
 *          cost-model.ts cellState — never guessed from mere absence).
 *   • nc  (Not covered) — the plan exists but won't pay for this service. Amber.
 *          A meaningful negative (covered === false).
 *   • unk (Not listed yet) — we don't have this detail yet. Muted slate. A DATA
 *          GAP, not a coverage fact — invites the member to upload the plan doc.
 *          Must never read as "$0" or "not covered".
 *
 * `cellState()` in cost-model.ts is the single classifier (ok | na | nc | unk);
 * this module owns the copy + tone + rendering. Chosen default style is
 * "labeled" (icon + word, color-toned text) per the design's locked decision.
 */

export type EmptyKind = "na" | "nc" | "unk";

interface EmptyMeta {
  /** Full label rendered in the cell + legend. */
  label: string;
  /** Short legend caption. */
  tip: string;
}

/** Single source of truth for how each empty state reads (design EMPTY_META). */
export const EMPTY_META: Record<EmptyKind, EmptyMeta> = {
  na: {
    label: "Not applicable",
    tip: "This plan has no such benefit — e.g. no out-of-network coverage.",
  },
  nc: {
    label: "Not covered",
    tip: "This plan exists but won't pay for this service — you'd pay in full.",
  },
  unk: {
    label: "Not listed yet",
    tip: "We don't have this detail yet. Upload the plan document to fill it in.",
  },
};

// Tone classes per kind. Tokens map from the design (compare-redesign.css):
//   na  → neutral grey            (slate-400 ink)
//   nc  → amber "worst" palette   (#b45309 ink / #fffbeb bg / #fcd34d line)
//   unk → muted slate             (#64748b ink / #f8fafc bg / #cbd5e1 line)
const TONE: Record<EmptyKind, { text: string; chipText: string; chipBg: string; chipRing: string }> = {
  na: {
    text: "text-slate-400",
    chipText: "text-slate-500",
    chipBg: "bg-slate-50",
    chipRing: "ring-slate-200",
  },
  nc: {
    text: "text-amber-700",
    chipText: "text-amber-800",
    chipBg: "bg-amber-50",
    chipRing: "ring-amber-300",
  },
  unk: {
    text: "text-slate-500",
    chipText: "text-slate-500",
    chipBg: "bg-slate-50",
    chipRing: "ring-slate-300",
  },
};

function EmptyIcon({ kind, className }: { kind: EmptyKind; className?: string }) {
  // na → slashed circle (∅) · nc → minus-in-circle (⊖) · unk → dashed question.
  if (kind === "na") {
    return (
      <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path strokeLinecap="round" d="M5.6 5.6l12.8 12.8" />
      </svg>
    );
  }
  if (kind === "nc") {
    return (
      <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path strokeLinecap="round" d="M7.5 12h9" />
      </svg>
    );
  }
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" strokeDasharray="3 3" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.6 9.4a2.4 2.4 0 113.5 2.6c-.6.4-1.1.9-1.1 1.7M12 17h.01" />
    </svg>
  );
}

/**
 * The "labeled" empty-state cell — icon + word, color-toned (chosen default).
 * Rendered in place of a cost value when cellState() resolves na / nc / unk.
 */
export function EmptyState({ kind, className }: { kind: EmptyKind; className?: string }) {
  const meta = EMPTY_META[kind];
  const tone = TONE[kind];
  return (
    <span
      className={cn("inline-flex items-center gap-1 text-xs font-medium", tone.text, className)}
      title={meta.tip}
    >
      <EmptyIcon kind={kind} className="w-3.5 h-3.5 shrink-0" />
      {meta.label}
    </span>
  );
}

/**
 * "What the blanks mean" legend strip — sits above the service-by-service tables
 * and decodes all three empty states with their live styling so a member can
 * read the table without guessing. Renders each kind as a tinted chip + short tip.
 */
export function EmptyLegend({ className }: { className?: string }) {
  const order: EmptyKind[] = ["na", "nc", "unk"];
  return (
    <div
      className={cn(
        "rounded-2xl bg-white ring-1 ring-slate-200 px-4 py-3",
        "flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4",
        className,
      )}
    >
      <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 shrink-0">
        What the blanks mean
      </span>
      <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2 sm:gap-3">
        {order.map((kind) => {
          const meta = EMPTY_META[kind];
          const tone = TONE[kind];
          return (
            <div key={kind} className="flex items-center gap-1.5 min-w-0">
              <span
                className={cn(
                  "inline-flex items-center gap-1 shrink-0 px-1.5 py-0.5 rounded-md text-[11px] font-semibold ring-1",
                  tone.chipText,
                  tone.chipBg,
                  tone.chipRing,
                )}
              >
                <EmptyIcon kind={kind} className="w-3 h-3 shrink-0" />
                {meta.label}
              </span>
              <span className="text-[11px] text-slate-500 leading-snug">{meta.tip}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
