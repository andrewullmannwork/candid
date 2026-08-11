/**
 * Shared "needs panel" format primitives — the control language and grouping
 * that make an input panel read the same everywhere: calm ✓-status or
 * value + Edit on answered rows, one action button on open rows, an
 * "ADDED (N) · Show/Hide" fold, and the quantity meter ("4 of 6 added").
 *
 * Extracted from CaseNeedsPanel (S308, Andrew: the letter page's "What we need
 * from you" and the claim rail's "Verify our assumptions" must give the user an
 * identical experience — one format, different fields). The row SHELL was
 * already shared (@/components/shared/InputRow, extracted from CostShareBanner
 * at dispute-letters v2); these are the remaining letter-panel pieces the rail
 * card lacked. Pure presentational; no state beyond the fold's open flag being
 * owned by the caller.
 */
import { type ReactNode } from "react";

export const strokeProps = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export const ImportantBadge = (
  <span className="inline-flex items-center rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
    Important
  </span>
);

export function DoneChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[13px] font-medium text-emerald-600">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 13l4 4L19 7" /></svg>
      {label}
    </span>
  );
}

/** "✓ <label> · Edit" — a resolved row that stays editable. */
export function DoneEdit({ label, onEdit }: { label: string; onEdit: () => void }) {
  return (
    <span className="inline-flex items-center gap-2.5 whitespace-nowrap">
      <span className="inline-flex items-center gap-1 text-[13px] font-medium text-emerald-600">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 13l4 4L19 7" /></svg>
        {label}
      </span>
      <button type="button" onClick={onEdit} className="text-[13px] font-medium text-blue-600 hover:text-blue-700">Edit</button>
    </span>
  );
}

export function AddButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="whitespace-nowrap rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-[13px] font-medium text-blue-700 transition-colors hover:border-blue-300 hover:bg-blue-50"
    >
      {label}
    </button>
  );
}

/** "<value> · Edit" — a stored value that stays correctable. */
export function ValueEdit({ value, onEdit }: { value: string; onEdit: () => void }) {
  return (
    <span className="inline-flex items-center gap-2.5 whitespace-nowrap">
      <span className="text-sm font-medium text-gray-900">{value}</span>
      <button type="button" onClick={onEdit} className="text-[13px] font-medium text-blue-600 hover:text-blue-700">Edit</button>
    </span>
  );
}

export function CancelLink({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="whitespace-nowrap text-[13px] font-medium text-gray-500 hover:text-gray-700">Cancel</button>
  );
}

/**
 * The quantity meter: a slim progress bar + "N of M added". The letter panel
 * passes its own suffix (" — each one makes the letter stronger"); callers with
 * no suffix get the bare count.
 */
export function NeedsMeter({
  completed,
  total,
  suffix = "",
}: {
  completed: number;
  total: number;
  suffix?: string;
}) {
  const pct = total === 0 ? 0 : Math.round((completed / total) * 100);
  return (
    <div data-meter className="mt-3 flex items-center gap-3">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100">
        <div className="h-full rounded-full bg-blue-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="whitespace-nowrap text-[12px] font-medium text-gray-500">
        {completed} of {total} added{suffix}
      </span>
    </div>
  );
}

/**
 * The "ADDED (N) · Show/Hide" fold. The caller owns the open flag (so panels
 * can keep their existing state) and passes the folded rows as children.
 */
export function AddedFold({
  count,
  open,
  onToggle,
  children,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div className="border-t border-gray-100">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-lg py-2.5 text-left transition-colors hover:bg-gray-50"
      >
        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
          Added ({count})
        </span>
        <span className="inline-flex items-center gap-1 text-[13px] font-medium text-blue-600">
          {open ? "Hide" : "Show"}
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            {...strokeProps}
            className={`transition-transform ${open ? "rotate-180" : ""}`}
            aria-hidden
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>
      {open ? children : null}
    </div>
  );
}
