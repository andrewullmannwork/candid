"use client";

import { type ReactNode, useState } from "react";
import { cn } from "@/lib/utils/cn";

/**
 * ComparisonSection — section wrapper for /compare 3-plan grid surfaces.
 *
 * Renders a section heading (uppercase blue eyebrow + black title + optional
 * collapsible toggle) above a content slot. Used by /compare only (B3.3
 * consumer).
 *
 * B3.3 — section-heading structure adopted from Phase 1 design
 * (plans/findings/design-handoffs/s112-full-refresh/project/compare.jsx
 * lines 688-720):
 *   - `eyebrow` = small uppercase blue label ("THE NUMBERS" / "EMERGENCY")
 *   - `title`   = larger black h2 ("Premiums, deductibles, and ceilings")
 *   - `collapsible` + `collapsedSummary` swap children for a single summary
 *     row when closed (used by service-category accordions)
 *   - `closedHint` / `openHint` add toggle text next to the chevron
 *   - Entire heading row is the click target when collapsible (bigger
 *     affordance than design's just-the-toggle-button)
 */

interface ComparisonSectionProps {
  /** Small uppercase blue label above the title (e.g., "THE NUMBERS"). */
  eyebrow?: string;
  /** Larger black h2 ("Premiums, deductibles, and ceilings"). */
  title: string;
  /** Optional small descriptive line under the title. */
  description?: string;
  /** Optional right-aligned slot in the heading row (non-collapsible only). */
  right?: ReactNode;
  /** When true, the heading row becomes a click target that toggles a
   *  chevron + swaps body content. Default false (flat section). */
  collapsible?: boolean;
  /** When `collapsible` is true, controls initial open state. Default false. */
  defaultOpen?: boolean;
  /** Body content shown when collapsible+closed (replaces `children`). */
  collapsedSummary?: ReactNode;
  /** Toggle hint text shown when closed (e.g., "Show all 3 services"). */
  closedHint?: string;
  /** Toggle hint text shown when open. Default "Hide details". */
  openHint?: string;
  children: ReactNode;
  className?: string;
}

export function ComparisonSection({
  eyebrow,
  title,
  description,
  right,
  collapsible = false,
  defaultOpen = false,
  collapsedSummary,
  closedHint,
  openHint = "Hide details",
  children,
  className,
}: ComparisonSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const isOpen = collapsible ? open : true;

  const heading = (
    <>
      <div className="min-w-0 flex-1">
        {eyebrow && (
          <div className="text-[11px] font-bold uppercase tracking-wider text-blue-600 mb-1">
            {eyebrow}
          </div>
        )}
        <h2 className="text-lg sm:text-xl font-semibold text-slate-900 tracking-tight">
          {title}
        </h2>
        {description && (
          <p className="mt-1 text-[13px] text-slate-500 leading-relaxed">
            {description}
          </p>
        )}
      </div>
      {!collapsible && right && <div className="flex-shrink-0">{right}</div>}
      {collapsible && (
        <div className="flex-shrink-0 flex items-center gap-1.5 text-sm font-semibold text-slate-500 group-hover:text-slate-700">
          <span className="hidden sm:inline">
            {isOpen ? openHint : closedHint ?? ""}
          </span>
          <svg
            className={cn(
              "w-4 h-4 transition-transform duration-200",
              isOpen && "rotate-180",
            )}
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      )}
    </>
  );

  return (
    <section className={cn("mt-8 sm:mt-10", className)}>
      {collapsible ? (
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={isOpen}
          className="w-full flex items-end justify-between gap-4 mb-3 text-left group"
        >
          {heading}
        </button>
      ) : (
        <div className="flex items-end justify-between gap-4 mb-3">{heading}</div>
      )}
      <div>{!isOpen && collapsedSummary ? collapsedSummary : children}</div>
    </section>
  );
}
