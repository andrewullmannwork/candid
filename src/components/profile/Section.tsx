"use client";

import { type ReactNode } from "react";

/**
 * Reusable section wrapper for /profile dashboard + (later) /billing dashboard
 * (S121 B2.1).
 *
 * Per Phase 1 §1.B.2 Rec 13 — generic enough to use across all 7 dashboard
 * sections + sibling /billing dashboard panels. Consistent eyebrow + title +
 * optional subtitle + optional right-aligned action button.
 */
interface SectionProps {
  eyebrow: string;
  title: string;
  subtitle?: string;
  actionLabel?: string;
  onAction?: () => void;
  children: ReactNode;
  compact?: boolean;
}

export function Section({
  eyebrow,
  title,
  subtitle,
  actionLabel,
  onAction,
  children,
  compact = false,
}: SectionProps) {
  return (
    <section
      className={`bg-white border border-gray-200 rounded-3xl ${
        compact ? "px-6 py-5" : "px-7 py-6"
      }`}
    >
      <div className="flex items-start justify-between gap-3 mb-5">
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-blue-600">
            {eyebrow}
          </div>
          <h2 className="mt-1 text-lg font-bold text-gray-900 tracking-[-0.01em]">
            {title}
          </h2>
          {subtitle && (
            <p className="mt-1 text-sm text-gray-500 leading-relaxed">
              {subtitle}
            </p>
          )}
        </div>
        {actionLabel && onAction && (
          <button
            type="button"
            onClick={onAction}
            className="shrink-0 text-sm font-semibold text-blue-600 hover:text-blue-700 px-3 py-1.5 rounded-lg hover:bg-blue-50 transition-colors"
          >
            {actionLabel}
          </button>
        )}
      </div>
      {children}
    </section>
  );
}
