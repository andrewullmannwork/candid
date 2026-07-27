"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils/cn";
import type { PremiumEntry, PremiumSource } from "../premium-model";

/**
 * Compare v2 (PR4) — premium suggestion/confirm cell (design PremiumCell).
 *
 * Five states: confirmed · ghost-suggestion · empty · editing · after-save(flash).
 * A premium is never presented as fact until confirmed — community/estimate render
 * as a tinted "Suggested" card the member must accept ("Use this") or type over.
 * Source maps to Display-State vocabulary: your_plan/user_input → green "Your plan";
 * community → blue "Community avg · N"; estimate → amber "Estimate". The "Includes
 * employer share" caveat carries through. Controlled — ResultsViewV2 owns the
 * premiums map, persistence, and the flywheel write.
 */

interface PremiumCellV2Props {
  entry: PremiumEntry;
  membersCount?: number | null;
  /** True only for the user's active (profile) plan — gates "Your"-framed copy.
   *  Non-profile columns use neutral "Premium" / "You entered" wording (S160). */
  isActivePlan?: boolean;
  /** Accept the ghost suggestion as-is (→ confirmed). */
  onConfirm: () => void;
  /** Save an entered value (+ employer caveat). */
  onSave: (value: number, inclEmployer: boolean) => void;
}

function fmtMembers(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}

export function PremiumCellV2({ entry, membersCount, isActivePlan = false, onConfirm, onSave }: PremiumCellV2Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.value != null ? String(entry.value) : "");
  const [inclEmp, setInclEmp] = useState(entry.inclEmployer);
  const [flash, setFlash] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const beginEdit = () => {
    setDraft(entry.value != null ? String(entry.value) : "");
    setInclEmp(entry.inclEmployer);
    setEditing(true);
  };
  const flashSaved = () => {
    setFlash(true);
    setTimeout(() => setFlash(false), 1500);
  };
  const save = () => {
    onSave(Math.max(0, Math.round(Number(draft) || 0)), inclEmp);
    setEditing(false);
    flashSaved();
  };
  const accept = () => {
    onConfirm();
    flashSaved();
  };

  if (editing) {
    return (
      <div className="w-full max-w-[210px] rounded-xl ring-1 ring-blue-200 bg-blue-50/40 p-2.5">
        <div className="text-[10px] font-bold uppercase tracking-wide text-blue-600 mb-1">{isActivePlan ? "Your premium" : "Premium"}</div>
        <div className="flex items-center gap-1">
          <span className="text-slate-400 text-sm">$</span>
          <input
            ref={inputRef}
            type="number"
            min={0}
            step={1}
            value={draft}
            placeholder="0"
            aria-label={isActivePlan ? "Your monthly premium" : "Monthly premium"}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") setEditing(false);
            }}
            className="w-20 bg-white rounded-md ring-1 ring-slate-200 px-2 py-1 text-sm font-semibold text-slate-900 tabular-nums focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
          <span className="text-[11px] text-slate-400">/mo</span>
        </div>
        <label className="group flex items-center gap-2 mt-2 text-[11px] text-slate-600 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={inclEmp}
            onChange={(e) => setInclEmp(e.target.checked)}
            aria-label="Includes employer share"
            className="peer sr-only"
          />
          <span
            aria-hidden="true"
            className={cn(
              "grid place-items-center w-4 h-4 rounded-[5px] ring-1 transition-all duration-150",
              "peer-focus-visible:ring-2 peer-focus-visible:ring-blue-400 peer-focus-visible:ring-offset-1",
              inclEmp
                ? "bg-blue-600 ring-blue-600 text-white shadow-sm"
                : "bg-white ring-slate-300 text-transparent group-hover:ring-slate-400",
            )}
          >
            <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 13l4 4L19 7" />
            </svg>
          </span>
          Includes employer share
        </label>
        <div className="flex items-center gap-2 mt-2">
          <button
            type="button"
            onClick={save}
            className="px-2.5 py-1 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700"
          >
            Save
          </button>
          <button type="button" onClick={() => setEditing(false)} className="text-xs text-slate-500 hover:text-slate-700">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (entry.value == null) {
    return (
      <div className="w-full max-w-[210px] rounded-xl ring-1 ring-blue-200 bg-blue-50/40 p-2.5">
        <div className="text-[10px] font-bold uppercase tracking-wide text-blue-600 mb-1.5">{isActivePlan ? "Add yours" : "Premium"}</div>
        {/* S289 (Andrew) — a real button, not a text link. */}
        <button
          type="button"
          onClick={beginEdit}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
          </svg>
          Enter premium
        </button>
      </div>
    );
  }

  if (entry.confirmed) {
    return (
      <div className={cn("flex flex-col items-start sm:items-center gap-0.5", flash && "animate-pulse")}>
        <div className="flex items-center gap-1.5">
          <span className="text-base font-semibold text-slate-900 tabular-nums">
            ${entry.value.toLocaleString()}
          </span>
          <span className="text-[11px] text-slate-400">/mo</span>
          {flash ? (
            <span className="inline-flex items-center gap-0.5 text-[11px] text-emerald-600 font-semibold">
              <CheckIcon /> Saved
            </span>
          ) : (
            <button
              type="button"
              onClick={beginEdit}
              aria-label="Edit premium"
              className="text-slate-400 hover:text-slate-600"
            >
              <PencilIcon />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <PremiumSourceTag source={entry.source} membersCount={membersCount} isActivePlan={isActivePlan} />
          {entry.inclEmployer && <span className="text-[10px] text-slate-400">incl. employer</span>}
        </div>
      </div>
    );
  }

  // ghost suggestion (unconfirmed) — tinted card signals "needs your input".
  const isEstimate = entry.source === "estimate";
  return (
    <div
      className={cn(
        "w-full max-w-[210px] rounded-xl ring-1 p-2.5",
        isEstimate ? "ring-amber-200 bg-amber-50/50" : "ring-blue-200 bg-blue-50/50",
      )}
    >
      <div
        className={cn(
          "text-[10px] font-bold uppercase tracking-wide mb-1",
          isEstimate ? "text-amber-700" : "text-blue-600",
        )}
      >
        {isEstimate ? "Suggested · estimate" : "Suggested · community"}
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-base font-semibold text-slate-500 tabular-nums">
          ${entry.value.toLocaleString()}
        </span>
        <span className="text-[11px] text-slate-400">/mo</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 mt-1.5">
        <button
          type="button"
          onClick={accept}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700"
        >
          <CheckIcon /> Use this
        </button>
        <button type="button" onClick={beginEdit} className="text-xs text-slate-500 hover:text-slate-700">
          {isActivePlan ? "Enter yours" : "Enter premium"}
        </button>
      </div>
    </div>
  );
}

function PremiumSourceTag({
  source,
  membersCount,
  isActivePlan,
}: {
  source: PremiumSource;
  membersCount?: number | null;
  isActivePlan?: boolean;
}) {
  if (source === "your_plan" || source === "user_input") {
    // Only the user's actual profile plan reads as "Your plan"; a premium typed
    // for any other column is just an entered value (S160 — Andrew).
    return isActivePlan ? (
      <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-emerald-700">
        <CheckIcon /> Your plan
      </span>
    ) : (
      <span className="text-[11px] font-semibold text-slate-500">You entered</span>
    );
  }
  if (source === "community") {
    return (
      <span className="text-[11px] font-semibold text-blue-700">
        Community avg{membersCount ? ` · ${fmtMembers(membersCount)}` : ""}
      </span>
    );
  }
  return <span className="text-[11px] font-semibold text-amber-700">Estimate</span>;
}

function CheckIcon() {
  return (
    <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}
function PencilIcon() {
  return (
    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" />
    </svg>
  );
}
