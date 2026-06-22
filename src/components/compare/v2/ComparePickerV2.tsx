"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { cn } from "@/lib/utils/cn";
import type {
  CurrentPlanSummary,
  PlanSearchResult,
  SlotState,
} from "../PlanSlot";
import type { RecentPlan } from "../compare-sessions";

/**
 * Compare v2 (PR5) — reusable picker (design PlanPicker): menu → search → upload,
 * + RECENT chips. Emits a resolved SlotState via onPick; the build path (PlanSlotV2)
 * stores it for deferred resolution, the results editor (PlanEditorPanelV2) resolves
 * it immediately. Reuses the live /api/plan/search endpoint + adds the §4.4 state
 * filter (server already supports `state`).
 */

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME",
  "MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI",
  "SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
];

interface ComparePickerV2Props {
  /** Offer "Use my current plan" when set (build slot 0 / editor when not excluded). */
  currentPlan: CurrentPlanSummary | null;
  /** Canonical/plan ids already chosen in other columns — excluded from search + recents. */
  excludeIds: string[];
  recents: RecentPlan[];
  onPick: (slot: SlotState) => void;
  /** Offer the upload option. Both the build picker and (S160) the results editor set
   *  this true — the editor's upload-swap routes through the same parse pipeline. */
  allowUpload?: boolean;
}

export function ComparePickerV2({
  currentPlan,
  excludeIds,
  recents,
  onPick,
  allowUpload = true,
}: ComparePickerV2Props) {
  const [mode, setMode] = useState<"menu" | "search" | "upload">("menu");

  if (mode === "search") {
    return (
      <SearchPicker
        excludeIds={excludeIds}
        onBack={() => setMode("menu")}
        onSelect={(plan) => onPick({ kind: "search", query: plan.name, selected: plan })}
      />
    );
  }
  if (mode === "upload") {
    return <UploadPicker onBack={() => setMode("menu")} onFile={(file) => onPick({ kind: "upload", file })} />;
  }

  const relevant = recents.filter((r) => !excludeIds.includes(r.ref.id)).slice(0, 3);
  return (
    <div className="space-y-2.5">
      {currentPlan && (
        <>
          <button
            type="button"
            onClick={() => onPick({ kind: "current", plan: currentPlan })}
            className="group w-full text-left p-3 rounded-xl bg-gradient-to-br from-emerald-50 via-white to-emerald-50 ring-2 ring-emerald-200 hover:ring-emerald-400 hover:shadow-md transition-all"
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="shrink-0 w-5 h-5 rounded-md bg-emerald-500 flex items-center justify-center">
                <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </span>
              <span className="text-sm font-semibold text-emerald-900">Use my current plan</span>
            </div>
            <p className="text-sm text-slate-800 break-words">{currentPlan.planName}</p>
            <p className="text-xs text-slate-500 mt-0.5 truncate">
              {[currentPlan.insurerName, currentPlan.planType, currentPlan.metalLevel].filter(Boolean).join(" · ")}
            </p>
          </button>
          <div className="flex items-center gap-3 py-1">
            <div className="flex-1 h-px bg-slate-200" />
            <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">or</span>
            <div className="flex-1 h-px bg-slate-200" />
          </div>
        </>
      )}

      <MenuButton
        label="Search by name"
        sublabel="1,700+ plans and growing"
        onClick={() => setMode("search")}
        icon="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
      />
      {allowUpload && (
        <MenuButton
          label="Upload a document"
          sublabel="SBC or plan PDF"
          onClick={() => setMode("upload")}
          icon="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
        />
      )}

      {relevant.length > 0 && (
        <div className="pt-1">
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">Recent</p>
          <div className="space-y-1.5">
            {relevant.map((r) => (
              <button
                key={`${r.ref.kind}:${r.ref.id}`}
                type="button"
                onClick={() =>
                  onPick({
                    kind: "search",
                    query: r.name,
                    selected: { id: r.ref.id, canonicalPlanId: r.ref.id, name: r.name },
                  })
                }
                className="w-full flex items-center gap-2 text-left px-2.5 py-1.5 rounded-lg bg-slate-50 hover:bg-blue-50 ring-1 ring-slate-200 hover:ring-blue-200 transition-colors"
              >
                <svg className="w-3.5 h-3.5 text-slate-400 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <span className="text-xs text-slate-700 truncate">{r.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MenuButton({
  label,
  sublabel,
  onClick,
  icon,
}: {
  label: string;
  sublabel: string;
  onClick: () => void;
  icon: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group w-full flex items-start gap-2.5 p-3 rounded-xl bg-slate-50 hover:bg-blue-50 ring-1 ring-slate-200 hover:ring-blue-300 transition-all text-left"
    >
      <span className="shrink-0 w-7 h-7 rounded-lg bg-white ring-1 ring-slate-200 group-hover:text-blue-600 flex items-center justify-center text-slate-600">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
        </svg>
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-semibold text-slate-900 group-hover:text-blue-700">{label}</span>
        <span className="block text-[11px] text-slate-500 mt-0.5">{sublabel}</span>
      </span>
    </button>
  );
}

function SearchPicker({
  excludeIds,
  onSelect,
  onBack,
}: {
  excludeIds: string[];
  onSelect: (plan: PlanSearchResult) => void;
  onBack: () => void;
}) {
  const { user } = useAuth();
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [results, setResults] = useState<PlanSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!user || query.trim().length < 3) {
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
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
          body: JSON.stringify({ query, ...(stateFilter ? { state: stateFilter } : {}) }),
        });
        if (res.ok) {
          const { plans } = await res.json();
          setResults(((plans as PlanSearchResult[]) || []).filter((p) => !excludeIds.includes(p.id)));
        }
      } catch {
        /* ignore */
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query, stateFilter, user, excludeIds]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 min-w-0">
        <button type="button" onClick={onBack} aria-label="Back" className="shrink-0 text-slate-400 hover:text-slate-700">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="flex-1 min-w-0 flex items-center gap-2 p-2.5 rounded-xl bg-slate-50 ring-1 ring-slate-200 focus-within:ring-2 focus-within:ring-blue-400 focus-within:bg-white">
          <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search plan or carrier…"
            className="flex-1 bg-transparent text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none min-w-0"
          />
          {searching && <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin shrink-0" />}
        </div>
        <select
          value={stateFilter}
          onChange={(e) => setStateFilter(e.target.value)}
          aria-label="Filter by state"
          className="shrink-0 rounded-xl ring-1 ring-slate-200 bg-white px-2 py-2 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-400"
        >
          <option value="">All states</option>
          {US_STATES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {query.trim().length >= 3 && results.length > 0 && (
        <div className="rounded-xl bg-white ring-1 ring-slate-200 max-h-72 overflow-y-auto">
          {results.map((plan) => (
            <button
              key={plan.id}
              type="button"
              onClick={() => onSelect(plan)}
              className="w-full text-left px-3 py-2.5 hover:bg-blue-50 border-b border-slate-100 last:border-b-0 group"
            >
              <p className="text-sm font-medium text-slate-900 group-hover:text-blue-700">{plan.name}</p>
              <p className="text-xs text-slate-500 mt-0.5">
                {[plan.insurerName, plan.type, plan.metalLevel, plan.state, plan.year]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </button>
          ))}
        </div>
      )}

      {query.trim().length >= 3 && results.length === 0 && !searching && (
        <div className="rounded-xl bg-amber-50 ring-1 ring-amber-200 p-3">
          <p className="text-xs text-amber-800">
            No {stateFilter ? `${stateFilter} ` : ""}plans match “{query}”. Try a carrier name{stateFilter ? ", clear the state filter," : ""} or upload the document.
          </p>
        </div>
      )}
      {query.trim().length > 0 && query.trim().length < 3 && (
        <p className="text-xs text-slate-500 px-1">Keep typing — at least 3 characters.</p>
      )}
    </div>
  );
}

const ACCEPTED_TYPES = ["application/pdf"];
const MAX_FILE_BYTES = 25 * 1024 * 1024;

function UploadPicker({ onFile, onBack }: { onFile: (file: File) => void; onBack: () => void }) {
  const [dragOver, setDragOver] = useState(false);
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
    <div className="space-y-2">
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file) accept(file);
        }}
        className={cn(
          "relative cursor-pointer rounded-xl border-2 border-dashed transition-all p-6 text-center",
          dragOver ? "border-blue-400 bg-blue-50" : "border-slate-300 hover:border-blue-300 bg-slate-50/50",
        )}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onBack();
          }}
          aria-label="Back"
          className="absolute top-2 left-2 text-slate-400 hover:text-slate-700"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) accept(file);
            e.target.value = "";
          }}
        />
        <div className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-white ring-1 ring-slate-200 mb-2">
          <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
          </svg>
        </div>
        <p className="text-sm font-semibold text-slate-900">Drop your SBC or plan PDF</p>
        <p className="text-[11px] text-slate-500 mt-0.5">or click to browse · PDF · up to 25MB · parses on add</p>
      </div>
      {error && <p className="text-xs text-rose-600">{error}</p>}
    </div>
  );
}
