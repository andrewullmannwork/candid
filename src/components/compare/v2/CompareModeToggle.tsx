"use client";

import { cn } from "@/lib/utils/cn";

/**
 * Compare v2 (PR3) — the 2-segment mode pill (design .cmp-modetoggle):
 * "Copays & coinsurance" (default) | "What I'd pay for a bill".
 *
 * Full-width segments on mobile (≤sm), inline pill on larger screens. Tablist
 * semantics so the active mode is announced.
 */

export type CompareMode = "copay" | "bill";

const SEGMENTS: ReadonlyArray<readonly [CompareMode, string]> = [
  ["copay", "Copays & coinsurance"],
  ["bill", "What I'd pay for a bill"],
];

interface CompareModeToggleProps {
  mode: CompareMode;
  onMode: (mode: CompareMode) => void;
}

export function CompareModeToggle({ mode, onMode }: CompareModeToggleProps) {
  return (
    <div
      role="tablist"
      aria-label="Comparison mode"
      className="inline-flex w-full sm:w-auto rounded-xl bg-slate-100 p-1 gap-1"
    >
      {SEGMENTS.map(([value, label]) => {
        const active = mode === value;
        return (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onMode(value)}
            className={cn(
              "flex-1 sm:flex-none px-4 py-2 rounded-lg text-sm font-semibold transition-colors whitespace-nowrap",
              active
                ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200"
                : "text-slate-500 hover:text-slate-700",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
