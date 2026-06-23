'use client';

/**
 * PlanChangeBanner — the #1 view-time "your plan changed" banner for
 * dispute_plan_pinning_v1 (Phase 3). Calm, confirm-gated: it never auto-changes
 * the letter. Surfaced by the dispute GET only when the user switched away from
 * this dispute's pinned plan after drafting it and the new plan would change the
 * numbers (see route.ts). "Keep" dismisses (persists); "Rebuild" re-pins to the
 * new plan via the Phase 4 repin path, which then shows the CoverageDiffPanel.
 */

import { useState } from 'react';

interface PlanChangeBannerProps {
  previousPlanName: string | null;
  newPlanName: string | null;
  changedAt: string; // ISO timestamp of the switch
  serviceDate: string | null; // YYYY-MM-DD
  recommend: 'keep' | 'rebuild' | null;
  onKeep: () => void | Promise<void>;
  onUpdate: () => void | Promise<void>;
}

function fmtDate(value: string | null): string | null {
  if (!value) return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function PlanChangeBanner({
  previousPlanName,
  newPlanName,
  changedAt,
  serviceDate,
  recommend,
  onKeep,
  onUpdate,
}: PlanChangeBannerProps) {
  const [busy, setBusy] = useState<null | 'keep' | 'update'>(null);
  const prev = previousPlanName ?? 'your previous plan';
  const next = newPlanName ?? 'your new plan';
  const svc = fmtDate(serviceDate);
  const chg = fmtDate(changedAt);

  const run = async (which: 'keep' | 'update', fn: () => void | Promise<void>) => {
    if (busy) return;
    setBusy(which);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3.5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-900">
            Your plan changed since this letter was drafted
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-slate-600">
            This letter is built on <span className="font-medium text-slate-900">{prev}</span>
            {svc ? (
              <>
                {' '}— the plan on file for the service date,{' '}
                <span className="font-medium text-slate-900">{svc}</span>
              </>
            ) : null}
            .{chg ? (
              <>
                {' '}On <span className="font-medium text-slate-900">{chg}</span> you switched to{' '}
                <span className="font-medium text-slate-900">{next}</span>.
              </>
            ) : (
              <>
                {' '}You switched to <span className="font-medium text-slate-900">{next}</span>.
              </>
            )}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => run('keep', onKeep)}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {busy === 'keep' ? 'Keeping…' : `Keep ${prev}`}
              {recommend === 'keep' && (
                <span className="rounded bg-white/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                  Recommended
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => run('update', onUpdate)}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-[13px] font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              {busy === 'update' ? 'Updating…' : `Rebuild on ${next}`}
              {recommend === 'rebuild' && (
                <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-700">
                  Recommended
                </span>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
