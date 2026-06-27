"use client";

// §18.10.D — the dispute-letter "confirm to strengthen" prompt. When the deductible-aware letter
// OMITS a precise dollar because a load-bearing input is unconfirmed (deductible / OOP / network),
// the backend returns `strengthenLetter.fields`; this surfaces ONLY those fields as confirmable
// rows. Confirming writes to the SAME cost-share-override endpoint the claim page uses (so it's
// bidirectional + never double-asks); the user then clicks Rebuild (manual, never automatic) to
// regenerate with the precise figure. The backend only offers a field when confirming it would
// actually unlock the dollar (rate-starved lines are suppressed upstream).
//
// Toggles match the claim-page assumptions banner: clicking a segment turns it green INSTANTLY
// (optimistic) and writes in the background. Binary — no date (the "as of" is optional + omitted).
// Collapse is owned by the PAGE (so "minimize after rebuild" persists + the user can reopen it).
// Generic by shape so the verification-surface consolidation (patient-name, same-insurer, service
// match) slots in as more item kinds — the planning-session unification.

import { useState, type ReactNode } from "react";

export type StrengthField = "deductible" | "oop" | "network";

interface Props {
  claimId: string;
  fields: StrengthField[];
  getToken: () => Promise<string>;
  onRebuild: () => void;
  rebuilding: boolean;
  collapsed: boolean;
  onToggleCollapsed: (collapsed: boolean) => void;
}

const GlobeIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18" />
  </svg>
);
const DollarIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 2v20M17 6.5C17 4.5 14.8 3.5 12 3.5S7 4.6 7 7s2.2 3.2 5 3.7 5 1.5 5 4-2.2 3.6-5 3.6-5-1.2-5-3" />
  </svg>
);

// label = the segment's text; value = the override-body value it commits.
const META: Record<StrengthField, { label: string; icon: ReactNode; desc: string; left: { label: string }; right: { label: string } }> = {
  network: { label: "Network", icon: GlobeIcon, desc: "We assumed this provider is in-network.", left: { label: "In-network" }, right: { label: "Out-of-network" } },
  deductible: { label: "Deductible", icon: DollarIcon, desc: "We're not sure your deductible has been met.", left: { label: "Not met" }, right: { label: "Met" } },
  oop: { label: "Out-of-pocket max", icon: DollarIcon, desc: "We're not sure you've hit your out-of-pocket max.", left: { label: "Not hit" }, right: { label: "Hit" } },
};

export function StrengthenLetterPrompt({ claimId, fields, getToken, onRebuild, rebuilding, collapsed, onToggleCollapsed }: Props) {
  const [selected, setSelected] = useState<Partial<Record<StrengthField, "left" | "right">>>({});
  const [pending, setPending] = useState<StrengthField | null>(null);
  const [error, setError] = useState<string | null>(null);

  function bodyFor(field: StrengthField, side: "left" | "right"): Record<string, unknown> {
    if (field === "network") return { field: "network", value: side === "left" ? "in_network" : "out_of_network" };
    const metField = field === "deductible" ? "deductible_met" : "oop_met";
    return { field: metField, met: side === "right", asOf: null }; // binary — date is optional, omitted
  }

  async function pick(field: StrengthField, side: "left" | "right") {
    const prev = selected[field];
    setSelected((s) => ({ ...s, [field]: side })); // optimistic green
    setError(null);
    setPending(field);
    try {
      const token = await getToken();
      const res = await fetch(`/api/claims/${claimId}/cost-share-override`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(bodyFor(field, side)),
      });
      if (!res.ok) { setSelected((s) => ({ ...s, [field]: prev })); setError("Couldn't save that — please try again."); }
    } catch {
      setSelected((s) => ({ ...s, [field]: prev }));
      setError("Couldn't save that — please try again.");
    } finally {
      setPending(null);
    }
  }

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => onToggleCollapsed(false)}
        className="inline-flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[13px] font-medium text-amber-800 hover:bg-amber-100"
      >
        <span className="text-amber-600">{DollarIcon}</span>
        Confirm details to strengthen letter
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 9l6 6 6-6" /></svg>
      </button>
    );
  }

  return (
    <div className="rounded-2xl border border-amber-200 bg-white p-5 shadow-sm">
      <div className="flex items-start gap-3.5">
        <div className="flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-amber-400 text-amber-950">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 3l7 4v5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V7l7-4z M9.5 12l1.8 1.8L15 10" /></svg>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-[17px] font-medium text-gray-900">Make this letter stronger</h3>
            <button type="button" onClick={() => onToggleCollapsed(true)} aria-label="Dismiss" className="-mr-1 rounded p-1 text-gray-400 hover:text-gray-600">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>
          </div>
          <p className="mt-1 text-[14px] leading-relaxed text-gray-600">
            We left exact dollar amounts off some charges because we&apos;re not certain of a couple of details.
            Confirm them and rebuild to state the precise figures.
          </p>
        </div>
      </div>

      <div className="mt-4 text-[11px] font-semibold uppercase tracking-[0.1em] text-gray-400">What we&apos;re unsure of</div>

      {fields.map((field) => {
        const m = META[field];
        const sel = selected[field];
        const isPending = pending === field;
        const seg = (side: "left" | "right", label: string) => {
          const active = sel === side;
          return (
            <button
              type="button"
              disabled={isPending}
              onClick={() => pick(field, side)}
              className={
                active
                  ? "rounded-md bg-white px-3 py-1.5 font-medium text-emerald-700 shadow-sm disabled:opacity-60"
                  : "rounded-md px-3 py-1.5 font-medium text-blue-600 hover:text-blue-800 disabled:opacity-60"
              }
            >
              {label}
            </button>
          );
        };
        return (
          <div key={field} className="border-t border-gray-100 py-3.5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-gray-50 text-gray-500">{m.icon}</div>
                <div className="pt-0.5">
                  <div className="text-sm font-medium text-gray-900">{m.label}</div>
                  <div className="mt-0.5 text-[13px] leading-snug text-gray-600">{m.desc}</div>
                </div>
              </div>
              <div className="inline-flex flex-none items-center rounded-lg border border-gray-200 bg-gray-50 p-0.5 text-[13px]">
                {seg("left", m.left.label)}
                {seg("right", m.right.label)}
              </div>
            </div>
          </div>
        );
      })}

      {error && <p className="mt-2 text-[13px] text-red-600">{error}</p>}

      <p className="mt-3 text-[12px] leading-relaxed text-gray-400">
        Confirm anything that&apos;s off and we&apos;ll rebuild a stronger letter. Your corrections also help us flag this provider for other members.
      </p>

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={() => { onToggleCollapsed(true); onRebuild(); }}
          disabled={rebuilding}
          className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-4 py-2 text-[13px] font-semibold text-white shadow-sm transition-all hover:bg-gray-800 active:scale-[0.98] disabled:opacity-60"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden className={rebuilding ? "animate-spin" : ""}><path d="M21 12a9 9 0 11-3-6.7L21 8" /><path d="M21 3v5h-5" /></svg>
          {rebuilding ? "Rebuilding…" : "Rebuild letter"}
        </button>
      </div>
    </div>
  );
}
