"use client";

/**
 * S70 follow-up — Unified PlanSlot card.
 *
 * One slot = one of (up to 3) plans the user is comparing. Each slot independently
 * supports three input modes:
 *   1. "current" — pre-fills from user's active insurance_plans → canonical
 *      (only available for slot 0 + only when user has an active plan).
 *   2. "search" — autocomplete via /api/plan/search.
 *   3. "upload" — single PDF picker; defers actual upload until parent submits.
 *
 * Per-slot state is owned by the parent (CompareInterface) so the parent can
 * coordinate "Compare these" submission across mixed modes.
 *
 * Visual treatment: rounded-3xl card, generous padding, gradient slot badge,
 * clear empty/active/committed states, smooth mode transitions.
 */

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";

export interface PlanSearchResult {
  id: string;
  name: string;
  type?: string;
  state?: string;
  metalLevel?: string;
  deductible?: number | null;
  oopMax?: number | null;
  year?: number;
  insurerName?: string;
}

export interface CurrentPlanSummary {
  /** canonical_plan_id resolved from the user's active insurance_plan. */
  canonicalPlanId: string;
  planName: string;
  insurerName: string;
  planType?: string | null;
  state?: string | null;
  metalLevel?: string | null;
  year?: number | null;
}

export type SlotState =
  | { kind: "empty" }
  | { kind: "search"; query: string; selected: PlanSearchResult | null }
  | { kind: "upload"; file: File | null }
  | { kind: "current"; plan: CurrentPlanSummary };

export interface PlanSlotProps {
  /** 0, 1, or 2 — drives the badge letter (A/B/C) + colored gradient. */
  index: number;
  /** Slot is optional (true for index ≥ 1; only first 2 are required). */
  optional: boolean;
  /** Show the "Use my current plan" affordance — only true for index 0 + when user has an active plan. */
  currentPlan: CurrentPlanSummary | null;
  /** Controlled state from parent. */
  state: SlotState;
  /** Callback to mutate state. */
  onChange: (next: SlotState) => void;
  /** Disabled when parent is submitting/parsing. */
  disabled?: boolean;
}

const SLOT_GRADIENTS: Record<number, { bg: string; ring: string; chip: string }> = {
  0: {
    bg: "bg-gradient-to-br from-blue-500 to-indigo-600",
    ring: "ring-blue-200",
    chip: "bg-blue-50 text-blue-700 ring-blue-200",
  },
  1: {
    bg: "bg-gradient-to-br from-indigo-500 to-violet-600",
    ring: "ring-indigo-200",
    chip: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  },
  2: {
    bg: "bg-gradient-to-br from-violet-500 to-fuchsia-600",
    ring: "ring-violet-200",
    chip: "bg-violet-50 text-violet-700 ring-violet-200",
  },
};

const ACCEPTED_TYPES = ["application/pdf"];
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export function PlanSlot({
  index,
  optional,
  currentPlan,
  state,
  onChange,
  disabled = false,
}: PlanSlotProps) {
  const letter = String.fromCharCode(65 + index);
  const palette = SLOT_GRADIENTS[index] ?? SLOT_GRADIENTS[0];

  // ── Committed view (any of 3 modes resolved to a value) ────────────
  if (state.kind === "current") {
    return (
      <CommittedSlot
        letter={letter}
        palette={palette}
        title={state.plan.planName}
        subtitle={[state.plan.insurerName, state.plan.planType, state.plan.metalLevel, state.plan.state]
          .filter(Boolean)
          .join(" · ")}
        sourceLabel="Your current plan"
        sourceVariant="emerald"
        disabled={disabled}
        onClear={() => onChange({ kind: "empty" })}
      />
    );
  }
  if (state.kind === "search" && state.selected) {
    const sel = state.selected;
    return (
      <CommittedSlot
        letter={letter}
        palette={palette}
        title={sel.name}
        subtitle={[sel.insurerName, sel.type, sel.metalLevel, sel.state].filter(Boolean).join(" · ")}
        sourceLabel="From plan search"
        sourceVariant="blue"
        disabled={disabled}
        onClear={() => onChange({ kind: "empty" })}
      />
    );
  }
  if (state.kind === "upload" && state.file) {
    const sizeKb = Math.round(state.file.size / 1024);
    return (
      <CommittedSlot
        letter={letter}
        palette={palette}
        title={state.file.name}
        subtitle={`${sizeKb.toLocaleString()} KB · PDF · will parse on Compare`}
        sourceLabel="Document upload"
        sourceVariant="violet"
        disabled={disabled}
        onClear={() => onChange({ kind: "empty" })}
      />
    );
  }

  // ── Empty / active-mode views ──────────────────────────────────────
  return (
    <div className="relative bg-white rounded-3xl ring-1 ring-slate-200 shadow-sm hover:shadow-md transition-shadow p-6 sm:p-7">
      <SlotHeader letter={letter} palette={palette} optional={optional} />

      {/* Mode picker — only when truly empty */}
      {state.kind === "empty" && (
        <ModePicker
          currentPlan={index === 0 ? currentPlan : null}
          onPickCurrent={(plan) => onChange({ kind: "current", plan })}
          onPickSearch={() => onChange({ kind: "search", query: "", selected: null })}
          onPickUpload={() => onChange({ kind: "upload", file: null })}
          disabled={disabled}
        />
      )}

      {/* Search active */}
      {state.kind === "search" && !state.selected && (
        <SearchActive
          query={state.query}
          onQueryChange={(q) => onChange({ kind: "search", query: q, selected: null })}
          onSelect={(plan) => onChange({ kind: "search", query: plan.name, selected: plan })}
          onCancel={() => onChange({ kind: "empty" })}
          disabled={disabled}
        />
      )}

      {/* Upload active */}
      {state.kind === "upload" && !state.file && (
        <UploadActive
          onFile={(file) => onChange({ kind: "upload", file })}
          onCancel={() => onChange({ kind: "empty" })}
          disabled={disabled}
        />
      )}
    </div>
  );
}

// ── Header ─────────────────────────────────────────────────────────────────

function SlotHeader({
  letter,
  palette,
  optional,
}: {
  letter: string;
  palette: (typeof SLOT_GRADIENTS)[number];
  optional: boolean;
}) {
  return (
    <div className="flex items-center gap-3 mb-5">
      <div
        className={`w-11 h-11 rounded-2xl ${palette.bg} flex items-center justify-center shadow-md shadow-slate-200`}
      >
        <span className="text-base font-bold text-white">{letter}</span>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-base font-semibold text-slate-900">
          Plan {letter}{" "}
          {optional && (
            <span className="text-xs font-normal text-slate-400 ml-1">(optional)</span>
          )}
        </p>
        <p className="text-xs text-slate-500 mt-0.5">
          {letter === "A" ? "Pick your first plan" : letter === "B" ? "Pick another plan" : "Add a third for richer comparison"}
        </p>
      </div>
    </div>
  );
}

// ── Mode picker ────────────────────────────────────────────────────────────

function ModePicker({
  currentPlan,
  onPickCurrent,
  onPickSearch,
  onPickUpload,
  disabled,
}: {
  currentPlan: CurrentPlanSummary | null;
  onPickCurrent: (plan: CurrentPlanSummary) => void;
  onPickSearch: () => void;
  onPickUpload: () => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2.5">
      {currentPlan && (
        <button
          type="button"
          onClick={() => onPickCurrent(currentPlan)}
          disabled={disabled}
          className="group w-full text-left p-4 rounded-2xl bg-gradient-to-br from-emerald-50 via-white to-emerald-50 ring-2 ring-emerald-200 hover:ring-emerald-400 hover:shadow-md transition-all disabled:opacity-50"
        >
          <div className="flex items-start gap-3">
            <div className="shrink-0 w-9 h-9 rounded-xl bg-emerald-500 flex items-center justify-center shadow-sm">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold text-emerald-900">Use my current plan</p>
                <span className="inline-flex items-center text-[10px] font-bold uppercase tracking-wider bg-emerald-600 text-white px-1.5 py-0.5 rounded-full">
                  1-click
                </span>
              </div>
              <p className="text-sm text-slate-700 mt-1 truncate">{currentPlan.planName}</p>
              <p className="text-xs text-slate-500 mt-0.5 truncate">
                {[currentPlan.insurerName, currentPlan.planType, currentPlan.metalLevel].filter(Boolean).join(" · ")}
              </p>
            </div>
            <svg className="w-4 h-4 text-emerald-600 shrink-0 mt-1 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </div>
        </button>
      )}

      {currentPlan && (
        <div className="flex items-center gap-3 py-1">
          <div className="flex-1 h-px bg-slate-200" />
          <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">or</span>
          <div className="flex-1 h-px bg-slate-200" />
        </div>
      )}

      {/* Q-CF30-9: responsive inner-grid. 2-col on mobile (cards full-width)
          and xl+ (cards ~427px+; buttons ~207px each); 1-col stacked at lg
          (1024-1279px) where outer grid switches to 3-col making each card
          ~310-340px and buttons in 2-col would shrink to ~140-160px and force
          label-overflow into 4-6 cramped lines. Labels render cleanly in all
          three breakpoint regimes after this change. */}
      <div className="grid grid-cols-2 lg:grid-cols-1 xl:grid-cols-2 gap-2.5">
        <ModeButton
          icon={
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          }
          label="Search by name"
          sublabel="50,000+ plans"
          onClick={onPickSearch}
          disabled={disabled}
        />
        <ModeButton
          icon={
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
          }
          label="Upload a document"
          sublabel="SBC or plan PDF"
          onClick={onPickUpload}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

function ModeButton({
  icon,
  label,
  sublabel,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  sublabel: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group flex items-start gap-2.5 p-3 rounded-xl bg-slate-50 hover:bg-blue-50 ring-1 ring-slate-200 hover:ring-blue-300 transition-all text-left disabled:opacity-50"
    >
      <div className="shrink-0 w-7 h-7 rounded-lg bg-white ring-1 ring-slate-200 group-hover:ring-blue-200 group-hover:text-blue-600 flex items-center justify-center text-slate-600 transition-colors">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-slate-900 group-hover:text-blue-700 transition-colors">{label}</p>
        <p className="text-[11px] text-slate-500 mt-0.5">{sublabel}</p>
      </div>
    </button>
  );
}

// ── Search active ──────────────────────────────────────────────────────────

function SearchActive({
  query,
  onQueryChange,
  onSelect,
  onCancel,
  disabled,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  onSelect: (plan: PlanSearchResult) => void;
  onCancel: () => void;
  disabled: boolean;
}) {
  const { user } = useAuth();
  const [results, setResults] = useState<PlanSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Auto-focus the input when it mounts.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!user || query.length < 3) {
      setResults([]);
      return;
    }
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      setSearching(true);
      try {
        const idToken = await user.firebaseUser.getIdToken();
        const res = await fetch("/api/plan/search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify({ query }),
        });
        if (res.ok) {
          const { plans } = await res.json();
          setResults(plans || []);
        }
      } catch {
        // ignore
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query, user]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 p-3.5 rounded-2xl bg-slate-50 ring-1 ring-slate-200 focus-within:ring-2 focus-within:ring-blue-400 focus-within:bg-white transition-all">
        <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search 50,000+ plans by name…"
          disabled={disabled}
          className="flex-1 bg-transparent text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none min-w-0 disabled:opacity-50"
        />
        {searching && (
          <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin shrink-0" />
        )}
        <button
          type="button"
          onClick={onCancel}
          disabled={disabled}
          className="text-xs font-medium text-slate-500 hover:text-slate-900 px-2 py-0.5 transition-colors"
          aria-label="Cancel search"
        >
          Cancel
        </button>
      </div>

      {query.length >= 3 && results.length > 0 && (
        <div className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm max-h-72 overflow-y-auto">
          {results.map((plan) => (
            <button
              key={plan.id}
              type="button"
              onClick={() => onSelect(plan)}
              className="w-full text-left px-4 py-3 hover:bg-blue-50 border-b border-slate-100 last:border-b-0 transition-colors group"
            >
              <p className="text-sm font-medium text-slate-900 group-hover:text-blue-700 transition-colors">
                {plan.name}
              </p>
              <p className="text-xs text-slate-500 mt-0.5">
                {plan.insurerName ? `${plan.insurerName} · ` : ""}
                {plan.type ?? ""}
                {plan.metalLevel ? ` · ${plan.metalLevel}` : ""}
                {plan.state ? ` · ${plan.state}` : ""}
                {plan.deductible != null ? ` · $${plan.deductible.toLocaleString()} deductible` : ""}
              </p>
            </button>
          ))}
        </div>
      )}

      {query.length >= 3 && results.length === 0 && !searching && (
        <p className="text-xs text-slate-500 px-2">
          No matches. Try a shorter query, or switch to{" "}
          <button onClick={onCancel} className="underline font-medium hover:text-slate-700">
            upload a document
          </button>{" "}
          instead.
        </p>
      )}
    </div>
  );
}

// ── Upload active ──────────────────────────────────────────────────────────

function UploadActive({
  onFile,
  onCancel,
  disabled,
}: {
  onFile: (file: File) => void;
  onCancel: () => void;
  disabled: boolean;
}) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function accept(file: File) {
    setError(null);
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setError(`"${file.name}" isn't a PDF — only PDFs are supported.`);
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError(`"${file.name}" is over 25MB.`);
      return;
    }
    onFile(file);
  }

  return (
    <div className="space-y-3">
      <div
        onClick={() => !disabled && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragOver(false);
          if (disabled) return;
          const file = e.dataTransfer.files?.[0];
          if (file) accept(file);
        }}
        className={`relative cursor-pointer rounded-2xl border-2 border-dashed transition-all p-7 text-center ${
          isDragOver
            ? "border-blue-400 bg-blue-50"
            : "border-slate-300 hover:border-blue-300 bg-slate-50/50 hover:bg-slate-50"
        } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          disabled={disabled}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) accept(file);
            e.target.value = "";
          }}
        />
        <div className="inline-flex items-center justify-center w-11 h-11 rounded-2xl bg-white ring-1 ring-slate-200 mb-3 shadow-sm">
          <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
          </svg>
        </div>
        <p className="text-sm font-semibold text-slate-900">Drop your plan PDF here</p>
        <p className="text-xs text-slate-500 mt-1">or click to browse · SBC or plan-summary · up to 25MB</p>
      </div>

      {error && (
        <div className="rounded-xl bg-rose-50 ring-1 ring-rose-200 px-3 py-2">
          <p className="text-xs text-rose-700">{error}</p>
        </div>
      )}

      <button
        type="button"
        onClick={onCancel}
        className="block mx-auto text-xs font-medium text-slate-500 hover:text-slate-900 transition-colors"
      >
        Cancel
      </button>
    </div>
  );
}

// ── Committed slot view (search-selected / upload-selected / current) ──────

function CommittedSlot({
  letter,
  palette,
  title,
  subtitle,
  sourceLabel,
  sourceVariant,
  disabled,
  onClear,
}: {
  letter: string;
  palette: (typeof SLOT_GRADIENTS)[number];
  title: string;
  subtitle: string;
  sourceLabel: string;
  sourceVariant: "emerald" | "blue" | "violet";
  disabled: boolean;
  onClear: () => void;
}) {
  const sourceClass =
    sourceVariant === "emerald"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
      : sourceVariant === "blue"
        ? "bg-blue-50 text-blue-700 ring-blue-200"
        : "bg-violet-50 text-violet-700 ring-violet-200";
  return (
    <div className={`relative bg-white rounded-3xl ring-1 ${palette.ring} shadow-sm p-6 sm:p-7`}>
      <div className="flex items-start gap-4">
        <div
          className={`shrink-0 w-11 h-11 rounded-2xl ${palette.bg} flex items-center justify-center shadow-md shadow-slate-200`}
        >
          <span className="text-base font-bold text-white">{letter}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`inline-flex items-center text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ring-1 ${sourceClass}`}>
              {sourceLabel}
            </span>
          </div>
          <p className="text-base font-semibold text-slate-900 truncate" title={title}>
            {title}
          </p>
          <p className="text-xs text-slate-500 mt-0.5 truncate">{subtitle}</p>
        </div>
        <button
          type="button"
          onClick={onClear}
          disabled={disabled}
          className="shrink-0 text-slate-400 hover:text-rose-600 transition-colors p-1 disabled:opacity-50"
          aria-label="Change selection"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
