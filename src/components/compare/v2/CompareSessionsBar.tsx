"use client";

import { cn } from "@/lib/utils/cn";
import { letterFor, planColorFor } from "../compare-colors";
import type { CompareSession } from "../compare-sessions";

/**
 * Compare v2 (PR5) — "Pick up where you left off" (design SessionsBar). One card per
 * saved comparison (overlapping A/B/C avatars + plan names); tap → re-resolve the
 * saved refs straight to results. Renders nothing when no sessions exist.
 */

interface CompareSessionsBarProps {
  sessions: CompareSession[];
  onResume: (session: CompareSession) => void;
}

export function CompareSessionsBar({ sessions, onResume }: CompareSessionsBarProps) {
  if (!sessions || sessions.length === 0) return null;
  return (
    <div className="mt-8">
      <div className="mb-3">
        <p className="text-sm font-semibold text-slate-900">Pick up where you left off</p>
        <p className="text-xs text-slate-500">Saved comparisons on this device — one tap to reopen.</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {sessions.map((s, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onResume(s)}
            className="text-left rounded-2xl bg-white ring-1 ring-slate-200 hover:ring-blue-300 hover:shadow-md transition-all p-4"
          >
            <div className="flex items-center gap-2 mb-2">
              <div className="flex -space-x-1.5">
                {s.plans.slice(0, 3).map((_, j) => (
                  <span
                    key={j}
                    className={cn(
                      "w-6 h-6 rounded-full ring-2 ring-white flex items-center justify-center text-white text-[10px] font-bold",
                      planColorFor(j).gradient,
                    )}
                  >
                    {letterFor(j)}
                  </span>
                ))}
              </div>
              <span className="text-xs font-semibold text-slate-500">{s.plans.length}-plan compare</span>
            </div>
            <div className="space-y-0.5">
              {s.plans.map((p, j) => (
                <div key={j} className="flex items-center gap-1.5">
                  <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", planColorFor(j).solid)} aria-hidden="true" />
                  <span className="text-xs text-slate-700 truncate">{p.name}</span>
                  {p.ref.kind === "user_plan" && (
                    <span className="text-[9px] font-bold uppercase tracking-wide text-emerald-600">You</span>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-2 text-xs font-semibold text-blue-600">Reopen comparison →</div>
          </button>
        ))}
      </div>
    </div>
  );
}
