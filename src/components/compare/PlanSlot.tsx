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

import {
  PlanSearchCountLine,
  PLAN_SEARCH_MIN_CHARS,
  PLAN_SEARCH_KEEP_TYPING,
} from "@/components/shared/PlanSearchCountLine";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { effectiveClientMaxBytes } from "@/lib/upload/upload-policy";
import { useUploadLimits } from "@/lib/upload/use-upload-limits";

/** Pattern 1 #16 vocabulary, compressed for search UI:
 *  - "verified"  — admin-attested (cold-start) OR canonical fully promoted
 *  - "community" — source_count ≥ 2 (multi-source aggregate, pre-promotion)
 *  - "estimated" — single source, awaiting corroboration
 */
export type PlanSearchBadgeLevel = "verified" | "community" | "estimated";

export interface PlanSearchResult {
  /** S107: id IS canonical_plans.id now (search source is canonical_plans;
   *  plan_catalog is no longer queried for search). Compare resolves via
   *  `canonicalPlanId` which mirrors `id` for back-compat. */
  id: string;
  canonicalPlanId?: string;
  name: string;
  type?: string;
  state?: string;
  metalLevel?: string;
  deductible?: number | null;
  oopMax?: number | null;
  year?: number;
  insurerName?: string;
  /** Surfaces the data-grade badge on the dropdown row + selected card. */
  badgeLevel?: PlanSearchBadgeLevel;
}

export interface CurrentPlanSummary {
  /** insurance_plans.id (always set; user owns the plan). */
  insurancePlanId: string;
  /** canonical_plan_id when the user's plan is linked to a canonical row.
   *  Null when the plan is user-only (e.g., uploaded SBC didn't match a canonical). */
  canonicalPlanId: string | null;
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

// B3.3 — gradients aligned to compare-colors.COMPARE_PLAN_COLORS (blue / purple
// / pink) so picker slot avatars match the per-plan summary card avatars in
// the results view. Source colors from Phase 1 design handoff
// (plans/findings/design-handoffs/s112-full-refresh/project/compare.jsx).
const SLOT_GRADIENTS: Record<number, { bg: string; ring: string; chip: string }> = {
  0: {
    bg: "bg-gradient-to-br from-blue-600 to-blue-700",
    ring: "ring-blue-200",
    chip: "bg-blue-50 text-blue-700 ring-blue-200",
  },
  1: {
    bg: "bg-gradient-to-br from-purple-700 to-purple-800",
    ring: "ring-purple-200",
    chip: "bg-purple-50 text-purple-700 ring-purple-200",
  },
  2: {
    bg: "bg-gradient-to-br from-pink-600 to-pink-700",
    ring: "ring-pink-200",
    chip: "bg-pink-50 text-pink-700 ring-pink-200",
  },
};

const ACCEPTED_TYPES = ["application/pdf"];

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
        badge={sel.badgeLevel ? <SearchBadge level={sel.badgeLevel} /> : null}
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
          className="group w-full text-left p-3 rounded-xl bg-gradient-to-br from-emerald-50 via-white to-emerald-50 ring-2 ring-emerald-200 hover:ring-emerald-400 hover:shadow-md transition-all disabled:opacity-50"
        >
          <div className="flex items-center gap-2 mb-1.5">
            <div className="shrink-0 w-5 h-5 rounded-md bg-emerald-500 flex items-center justify-center shadow-sm">
              <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="text-sm font-semibold text-emerald-900 truncate">Use my current plan</p>
          </div>
          <p className="text-sm text-slate-800 break-words" title={currentPlan.planName}>{currentPlan.planName}</p>
          <p className="text-xs text-slate-500 mt-0.5 truncate">
            {[currentPlan.insurerName, currentPlan.planType, currentPlan.metalLevel].filter(Boolean).join(" · ")}
          </p>
        </button>
      )}

      {currentPlan && (
        <div className="flex items-center gap-3 py-1">
          <div className="flex-1 h-px bg-slate-200" />
          <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">or</span>
          <div className="flex-1 h-px bg-slate-200" />
        </div>
      )}

      <div className="grid grid-cols-1 gap-2.5">
        <ModeButton
          icon={
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          }
          label="Search by name"
          sublabel="1,700+ plans and growing"
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
  const [searchTotal, setSearchTotal] = useState(0);
  const [searching, setSearching] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Auto-focus the input when it mounts.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!user || query.length < PLAN_SEARCH_MIN_CHARS) {
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
          const { plans, total } = await res.json();
          setResults(plans || []);
          setSearchTotal(typeof total === "number" ? total : (plans || []).length);
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
          placeholder="Search 1,700+ plans by name…"
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

      {query.length >= PLAN_SEARCH_MIN_CHARS && results.length > 0 && (
        <div className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm max-h-72 overflow-y-auto">
          <PlanSearchCountLine shown={results.length} total={searchTotal} />
          {results.map((plan) => (
            <button
              key={plan.id}
              type="button"
              onClick={() => onSelect(plan)}
              className="w-full text-left px-4 py-3 hover:bg-blue-50 border-b border-slate-100 last:border-b-0 transition-colors group"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium text-slate-900 group-hover:text-blue-700 transition-colors flex-1 min-w-0">
                  {plan.name}
                </p>
                {plan.badgeLevel && (
                  <SearchBadge level={plan.badgeLevel} />
                )}
              </div>
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

      {query.length > 0 && query.length < PLAN_SEARCH_MIN_CHARS && (
        <p className="text-xs text-slate-500 px-2">{PLAN_SEARCH_KEEP_TYPING}</p>
      )}

      {query.length >= PLAN_SEARCH_MIN_CHARS && results.length === 0 && !searching && (
        // S107: when search returns no canonical matches, point the user at
        // upload. The cold-start inventory is growing daily; a missing plan
        // means we don't have it yet — uploading their SBC adds it for them
        // (user_plan path) AND seeds the canonical via Pattern 2 identity
        // matching so the next user finds it via search.
        <div className="rounded-2xl bg-amber-50 ring-1 ring-amber-200 p-4">
          <p className="text-sm font-semibold text-amber-900">
            Don&rsquo;t see your plan?
          </p>
          <p className="text-xs text-amber-800 mt-1">
            Upload your SBC and we&rsquo;ll add it for you — and for everyone
            else searching for it later.
          </p>
          <a
            href="/upload"
            className="inline-flex items-center gap-1.5 mt-3 text-sm font-semibold text-amber-900 hover:text-amber-700"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            Upload your SBC
          </a>
        </div>
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

  // S322 — the size ceiling derives from the live admin-tuned limit (was a
  // hardcoded 25MB that no admin setting could reach).
  const uploadLimits = useUploadLimits();
  const maxFileBytes = effectiveClientMaxBytes(uploadLimits);
  const maxFileMb = Math.round(maxFileBytes / 1024 / 1024);

  function accept(file: File) {
    setError(null);
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setError(`"${file.name}" isn't a PDF — only PDFs are supported.`);
      return;
    }
    if (file.size > maxFileBytes) {
      setError(`"${file.name}" is over ${maxFileMb}MB.`);
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
        <p className="text-xs text-slate-500 mt-1">or click to browse · SBC or plan-summary · up to {maxFileMb}MB</p>
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
  badge,
  disabled,
  onClear,
}: {
  letter: string;
  palette: (typeof SLOT_GRADIENTS)[number];
  title: string;
  subtitle: string;
  sourceLabel: string;
  sourceVariant: "emerald" | "blue" | "violet";
  badge?: React.ReactNode;
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
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className={`inline-flex items-center text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ring-1 ${sourceClass}`}>
              {sourceLabel}
            </span>
            {badge}
          </div>
          <p className="text-base font-semibold text-slate-900 break-words" title={title}>
            {title}
          </p>
          <p className="text-xs text-slate-500 mt-0.5 break-words">{subtitle}</p>
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

// ── Search-result data-grade badge (verified / community / estimated) ──────

const BADGE_STYLES: Record<
  PlanSearchBadgeLevel,
  { label: string; className: string; title: string }
> = {
  verified: {
    label: "Verified",
    className: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    title: "Admin-attested or canonical-promoted plan — full coverage data.",
  },
  community: {
    label: "Community",
    className: "bg-blue-50 text-blue-700 ring-blue-200",
    title:
      "Aggregated from multiple users' uploads. Pending canonical promotion.",
  },
  estimated: {
    label: "Estimated",
    className: "bg-amber-50 text-amber-700 ring-amber-200",
    title:
      "Single-source data awaiting corroboration from another user's upload.",
  },
};

function SearchBadge({ level }: { level: PlanSearchBadgeLevel }) {
  const style = BADGE_STYLES[level];
  return (
    <span
      title={style.title}
      className={`inline-flex items-center text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ring-1 ${style.className}`}
    >
      {style.label}
    </span>
  );
}
