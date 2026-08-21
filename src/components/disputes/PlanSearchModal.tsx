"use client";

/**
 * PlanSearchModal — S111 unified replacement for SearchCanonicalPlanModal.
 *
 * Layout matches the Claude Design handoff (plans/findings/design-handoffs/
 * s110-plan-search-modal/project/Plan Search Modal.html):
 *
 *   ┌────────────────────────────────────────┐
 *   │  Header + close                        │
 *   ├────────────────────────────────────────┤
 *   │  Tabs · Search library | Upload my plan│
 *   ├────────────────────────────────────────┤
 *   │  (sticky)                              │
 *   │   ┌──────────────────────────────────┐ │
 *   │   │ 🔍 single search input           │ │
 *   │   └──────────────────────────────────┘ │
 *   │   Insurer · Year · State    23 results │
 *   ├────────────────────────────────────────┤
 *   │  Results list (scrollable inside body) │
 *   │  ...                                   │
 *   ├────────────────────────────────────────┤
 *   │  Footer · select esc close | Skip…    │
 *   └────────────────────────────────────────┘
 *
 * Modes:
 *   auto    — opened from VerifStrip Yes. Pre-fills insurer + year; shows
 *             "Likely match" auto-strip when one canonical clearly wins;
 *             Skip button = "use current plan as evidence" (closes modal,
 *             leaves user in bound-proxy state).
 *   search  — opened from "Find in library" / "Change". User-driven search.
 *   upload  — opened from "Upload my plan" or D6 gap CTA. In-modal pipeline
 *             POSTs to /api/documents/upload then polls /api/documents/status.
 *   confirm — user picked a result. Plan card + confirm CTA.
 *   bound   — brief success flash; auto-closes after parent refetch.
 *
 * Year auto-relax: when initial search at bill year yields 0 results, we
 * automatically retry without the year filter and surface a small notice so
 * the user sees broader matches without having to fight the chip. Year
 * filter remains user-controllable; auto-relax only fires once per modal
 * open + only when the user hasn't manually adjusted the year.
 *
 * Modal is height-capped at calc(100vh - 3rem); the m-body region is the
 * only scrollable surface so the header + footer stay anchored even when
 * results overflow.
 */

import {
  ChangeEvent,
  DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { uploadDocumentFile } from "@/lib/upload/client-upload";
import { effectiveClientMaxBytes } from "@/lib/upload/upload-policy";
import { useUploadLimits } from "@/lib/upload/use-upload-limits";

// ─── Types ──────────────────────────────────────────────────────────────────

export type PlanSearchModalMode =
  | "auto"
  | "search"
  | "upload"
  | "confirm"
  | "bound";

type BadgeLevel = "verified" | "community" | "estimated";

interface SearchResult {
  id: string;
  canonicalPlanId: string;
  hiosId: string | null;
  name: string;
  type: string | null;
  state: string | null;
  metalLevel: string | null;
  year: number | null;
  insurerName: string;
  badgeLevel: BadgeLevel;
}

interface InsurerOption {
  id: string;
  name: string;
}

interface ArchiveSuggestion {
  id: string;
  planName: string | null;
  planYear: number | null;
  insurerName: string | null;
}

interface Filters {
  insurerName: string | null;
  year: number | null;
  state: string | null;
}

export interface PlanSearchModalProps {
  open: boolean;
  initialMode: PlanSearchModalMode;
  disputeId: string;
  billYear: number;
  /** User's profile state, pre-fills the state filter when known. */
  userState: string | null;
  /** Insurer name pre-filled in auto mode (from current plan / fallbackPlan). */
  initialInsurerName: string | null;
  /** Best-match suggestion for auto mode (planContext.archiveCanonicalPlan). */
  archiveSuggestion: ArchiveSuggestion | null;
  getAuthToken: () => Promise<string | null>;
  /** Called after a successful bind. Parent refetches dispute so the strip
   *  morphs to bound-verified + the letter regenerates. */
  onBound: () => Promise<void>;
  /** Called after upload pipeline finishes parsing. Parent refetches;
   *  planContext.plan should populate. */
  onUploaded: () => Promise<void>;
  /** S111 smoke #4 — invoked when the user clicks the footer's "Use current
   *  plan as evidence (weaker)" button (formerly "Skip — use statutory
   *  framing"). Parent POSTs confirm-same-plan with acceptedProxy=true so
   *  the strip transitions to bound-proxy. Distinct from onClose (cancel)
   *  because Skip here is an explicit proxy choice. */
  onSkipToProxy: () => Promise<void>;
  onClose: () => void;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const SEARCH_DEBOUNCE_MS = 200;
const STATUS_POLL_MS = 2_000;
const STATUS_POLL_MAX_MS = 90_000;
const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL",
  "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME",
  "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH",
  "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
  "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI",
  "WY",
];

// ─── Component ──────────────────────────────────────────────────────────────

export function PlanSearchModal(props: PlanSearchModalProps) {
  const {
    open,
    initialMode,
    disputeId,
    billYear,
    userState,
    initialInsurerName,
    archiveSuggestion,
    getAuthToken,
    onBound,
    onUploaded,
    onSkipToProxy,
    onClose,
  } = props;

  const [mode, setMode] = useState<PlanSearchModalMode>(initialMode);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Filters>({
    insurerName: null,
    year: billYear,
    state: userState ?? null,
  });
  // Year auto-relax tracking — fires only once per modal open and only when
  // the user hasn't manually changed the year chip.
  const [yearAutoRelaxed, setYearAutoRelaxed] = useState(false);
  const [yearUserTouched, setYearUserTouched] = useState(false);

  // Search state
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchExecuted, setSearchExecuted] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Confirm state
  const [selectedResult, setSelectedResult] = useState<SearchResult | null>(
    null,
  );
  const [binding, setBinding] = useState(false);
  const [bindError, setBindError] = useState<string | null>(null);

  // Upload state
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadStage, setUploadStage] = useState<
    "idle" | "uploading" | "parsing" | "done" | "error"
  >("idle");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadDocumentId, setUploadDocumentId] = useState<string | null>(null);

  // No top-level input ref — SearchInput receives autoFocus prop natively
  // (eslint react-hooks/refs forbids passing refs through component props).

  // ── Lifecycle: reset on open ─────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    setMode(initialMode);
    setQuery("");
    setFilters({
      insurerName: initialMode === "auto" ? initialInsurerName : null,
      year: billYear,
      state: userState ?? null,
    });
    setYearAutoRelaxed(false);
    setYearUserTouched(false);
    setResults([]);
    setSearching(false);
    setSearchExecuted(false);
    setSearchError(null);
    setSelectedResult(null);
    setBinding(false);
    setBindError(null);
    setUploadFile(null);
    setUploadStage("idle");
    setUploadError(null);
    setUploadDocumentId(null);
  }, [open, initialMode, initialInsurerName, billYear, userState]);

  // ── ESC to close ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // ── Live search ──────────────────────────────────────────────────────────
  // Single source for both auto + search modes. Debounced 200ms. Searches by
  // plan_name (server) AND post-filters insurer client-side when the chip
  // is set + the server returns results not matching (defensive — the API
  // already does this via insurerHint when query >= 2 chars).
  useEffect(() => {
    if (!open) return;
    if (mode !== "auto" && mode !== "search") return;

    const trimmedQuery = query.trim();
    // Auto mode: search even without a query (uses insurer + year + state
    // filters to surface the cohort). Search mode: also fire with no query,
    // letting filters drive the list.
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      setSearchError(null);
      try {
        const token = await getAuthToken();
        if (!token) {
          setSearchError("Sign-in expired. Please reload and try again.");
          return;
        }
        const data = await fetchSearchResults({
          token,
          query: trimmedQuery,
          filters,
        });
        if (cancelled) return;

        // Year auto-relax: if 0 results AND year filter is set AND user
        // hasn't manually touched the year, retry without the year. Surface
        // the relaxation via the `yearAutoRelaxed` notice (rendered below
        // the chip row).
        if (
          data.length === 0 &&
          filters.year != null &&
          !yearUserTouched &&
          !yearAutoRelaxed
        ) {
          const relaxed = await fetchSearchResults({
            token,
            query: trimmedQuery,
            filters: { ...filters, year: null },
          });
          if (cancelled) return;
          setResults(relaxed);
          setSearchExecuted(true);
          setYearAutoRelaxed(true);
          // Clear the year filter visually too so the chip reflects reality
          setFilters((f) => ({ ...f, year: null }));
        } else {
          setResults(data);
          setSearchExecuted(true);
        }
      } catch (err) {
        if (cancelled) return;
        setSearchError(err instanceof Error ? err.message : "Search failed");
        setResults([]);
        setSearchExecuted(true);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    open,
    mode,
    query,
    filters,
    yearUserTouched,
    yearAutoRelaxed,
    getAuthToken,
  ]);

  // ── Best-match highlight: only fires in auto mode + on the archive
  //    suggestion. Pattern 1 #2: never silent auto-bind; the highlight is a
  //    UI hint, the user still clicks "Use this plan".
  const bestMatchId = useMemo<string | null>(() => {
    if (mode !== "auto" || !archiveSuggestion?.id) return null;
    return (
      results.find((r) => r.canonicalPlanId === archiveSuggestion.id)
        ?.canonicalPlanId ?? null
    );
  }, [mode, results, archiveSuggestion]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleSelectResult = useCallback((result: SearchResult) => {
    setSelectedResult(result);
    setBindError(null);
    setMode("confirm");
  }, []);

  const handleConfirmBind = useCallback(async () => {
    if (!selectedResult || binding) return;
    setBinding(true);
    setBindError(null);
    try {
      const token = await getAuthToken();
      if (!token) throw new Error("Sign-in expired. Please reload and try again.");
      const res = await fetch(
        `/api/disputes/${disputeId}/bind-canonical`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ canonicalPlanId: selectedResult.canonicalPlanId }),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Bind failed (${res.status})`);
      }
      setMode("bound");
      await onBound();
      setTimeout(() => onClose(), 700);
    } catch (err) {
      setBindError(err instanceof Error ? err.message : "Failed to bind plan");
      setBinding(false);
    }
  }, [selectedResult, binding, disputeId, getAuthToken, onBound, onClose]);

  const handleBackToSearch = useCallback(() => {
    setSelectedResult(null);
    setBindError(null);
    setMode(initialMode === "auto" ? "auto" : "search");
  }, [initialMode]);

  // ── Upload pipeline ──────────────────────────────────────────────────────
  const performUpload = useCallback(
    async (file: File) => {
      setUploadFile(file);
      setUploadStage("uploading");
      setUploadError(null);
      try {
        const token = await getAuthToken();
        if (!token) throw new Error("Sign-in expired. Please reload and try again.");
        // S322 — shared client helper (legacy body-POST or direct-to-storage
        // past the Vercel body cap). The old form's `planYear` field was never
        // read by the upload route (only file/docType/turnstileToken/purpose)
        // — dropped, not migrated.
        const res = await uploadDocumentFile({
          file,
          docType: "plan_document",
          idToken: token,
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `Upload failed (${res.status})`);
        }
        const data = (await res.json()) as { documentId?: string };
        if (!data.documentId) throw new Error("Upload succeeded but no documentId returned");
        setUploadDocumentId(data.documentId);
        setUploadStage("parsing");
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : "Upload failed");
        setUploadStage("error");
      }
    },
    [getAuthToken],
  );

  useEffect(() => {
    if (!open || uploadStage !== "parsing" || !uploadDocumentId) return;
    let cancelled = false;
    const started = Date.now();
    const tick = async () => {
      if (cancelled) return;
      if (Date.now() - started > STATUS_POLL_MAX_MS) {
        setUploadStage("done");
        await onUploaded();
        setTimeout(() => onClose(), 700);
        return;
      }
      try {
        const token = await getAuthToken();
        if (!token) return;
        const res = await fetch(
          `/api/documents/status/${uploadDocumentId}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (res.ok) {
          const data = (await res.json()) as { status?: string };
          const status = data.status ?? "";
          const stable = [
            "complete",
            "auto_processed",
            "awaiting_confirmation",
            "dedup_processed",
            "rejected",
            "pending_review",
          ].includes(status);
          if (stable) {
            setUploadStage("done");
            await onUploaded();
            setTimeout(() => onClose(), 700);
            return;
          }
        }
      } catch {
        // ignore transient poll errors; keep ticking until timeout
      }
      setTimeout(tick, STATUS_POLL_MS);
    };
    const timer = setTimeout(tick, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, uploadStage, uploadDocumentId, getAuthToken, onUploaded, onClose]);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const file = e.dataTransfer.files?.[0];
      if (file) void performUpload(file);
    },
    [performUpload],
  );

  const handleFileChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void performUpload(file);
    },
    [performUpload],
  );

  const handleRetryUpload = useCallback(() => {
    setUploadFile(null);
    setUploadStage("idle");
    setUploadError(null);
    setUploadDocumentId(null);
  }, []);

  // ── Filter handlers ──────────────────────────────────────────────────────
  const setYearFilter = useCallback((year: number | null) => {
    setYearUserTouched(true);
    setFilters((f) => ({ ...f, year }));
  }, []);

  const setInsurerFilter = useCallback((insurerName: string | null) => {
    setFilters((f) => ({ ...f, insurerName }));
  }, []);

  const setStateFilter = useCallback((state: string | null) => {
    setFilters((f) => ({ ...f, state }));
  }, []);

  if (!open) return null;

  const insurerClause = filters.insurerName ?? initialInsurerName ?? "your insurer";
  const showTabs = mode === "search" || mode === "auto" || mode === "upload";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
    >
      <div className="flex max-h-[calc(100vh-3rem)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <ModalHeader
          mode={mode}
          billYear={billYear}
          insurerName={initialInsurerName}
          onClose={onClose}
        />

        {showTabs && (
          <ModalTabs
            mode={mode}
            onSwitchSearch={() => setMode(initialMode === "auto" ? "auto" : "search")}
            onSwitchUpload={() => setMode("upload")}
          />
        )}

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {(mode === "search" || mode === "auto") && (
            <>
              {mode === "auto" && (
                <AutoStripNotice
                  searching={searching}
                  best={
                    bestMatchId
                      ? results.find((r) => r.canonicalPlanId === bestMatchId) ?? null
                      : null
                  }
                  resultsCount={results.length}
                  insurerClause={insurerClause}
                  billYear={billYear}
                  yearAutoRelaxed={yearAutoRelaxed}
                />
              )}

              <SearchStack
                mode={mode}
                query={query}
                setQuery={setQuery}
                filters={filters}
                billYear={billYear}
                setInsurerFilter={setInsurerFilter}
                setYearFilter={setYearFilter}
                setStateFilter={setStateFilter}
                resultsCount={results.length}
                searching={searching}
                getAuthToken={getAuthToken}
                yearAutoRelaxed={yearAutoRelaxed}
                onReapplyYear={() => {
                  setYearAutoRelaxed(false);
                  setYearFilter(billYear);
                }}
              />

              {searchError && (
                <div className="mx-6 my-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  {searchError}
                </div>
              )}

              <ResultsList
                results={results}
                searching={searching}
                searchExecuted={searchExecuted}
                bestMatchId={bestMatchId}
                query={query}
                onSelect={handleSelectResult}
                onSwitchToUpload={() => setMode("upload")}
              />
            </>
          )}

          {mode === "upload" && (
            <UploadPane
              billYear={billYear}
              uploadStage={uploadStage}
              uploadFile={uploadFile}
              uploadError={uploadError}
              onDrop={handleDrop}
              onFileChange={handleFileChange}
              onRetry={handleRetryUpload}
            />
          )}

          {mode === "confirm" && selectedResult && (
            <ConfirmPane
              result={selectedResult}
              binding={binding}
              bindError={bindError}
            />
          )}

          {mode === "bound" && selectedResult && (
            <BoundFlash result={selectedResult} />
          )}
        </div>

        <ModalFooter
          mode={mode}
          onSkipToProxy={async () => {
            await onSkipToProxy();
            onClose();
          }}
          onBackToSearch={() => setMode("search")}
          onConfirm={handleConfirmBind}
          onBackToConfirm={handleBackToSearch}
          binding={binding}
        />
      </div>
    </div>
  );
}

// ─── Server search helper ───────────────────────────────────────────────────

async function fetchSearchResults(params: {
  token: string;
  query: string;
  filters: Filters;
}): Promise<SearchResult[]> {
  const { token, query, filters } = params;

  // Server requires query.length >= 2. When the user hasn't typed yet, fall
  // back to a wildcard-style probe seeded by the insurer name (auto mode
  // pre-fills it) so the cohort surfaces immediately. Otherwise return [].
  const effectiveQuery = query.length >= 2 ? query : filters.insurerName ?? "";
  if (effectiveQuery.length < 2) return [];

  const body: Record<string, unknown> = {
    query: effectiveQuery,
    canonicalOnly: true,
  };
  if (filters.year != null) body.planYear = filters.year;
  if (filters.insurerName) body.insurerHint = filters.insurerName;
  if (filters.state) body.state = filters.state;

  const res = await fetch("/api/plan/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Search failed (${res.status})`);
  }
  const data = (await res.json()) as { plans?: SearchResult[] };
  return data.plans ?? [];
}

// ─── Header ─────────────────────────────────────────────────────────────────

function ModalHeader(props: {
  mode: PlanSearchModalMode;
  billYear: number;
  insurerName: string | null;
  onClose: () => void;
}) {
  const insurerClause = props.insurerName ?? "your insurer";
  let title = "";
  let sub = "";
  let success = false;
  if (props.mode === "auto") {
    title = `Find your ${props.billYear} plan in Candid's library`;
    sub = `If we can corroborate the plan in our library, this letter will cite the actual ${props.billYear} terms instead of falling back to a statutory framing.`;
  } else if (props.mode === "search") {
    title = `Find your ${props.billYear} plan in Candid's library`;
    sub =
      "Bind a community-corroborated canonical so this letter cites the actual plan terms.";
  } else if (props.mode === "upload") {
    title = `Upload your ${props.billYear} plan document`;
    sub =
      "PDF of the Summary of Benefits and Coverage (SBC) or the full plan booklet. We parse the cost-sharing terms locally and never share the document.";
  } else if (props.mode === "confirm") {
    title = "Cite this plan in your letter?";
    sub =
      "We'll re-frame the closing argument around this plan's actual cost-sharing terms.";
    success = true;
  } else if (props.mode === "bound") {
    title = "Plan bound";
    sub = `Regenerating your dispute letter with the cited ${insurerClause} terms…`;
    success = true;
  }

  return (
    <div className="flex items-start gap-3 border-b border-slate-100 px-6 py-4">
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
          success
            ? "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200"
            : "bg-blue-50 text-blue-600 ring-1 ring-inset ring-blue-100"
        }`}
      >
        {props.mode === "upload" ? (
          <UploadIcon />
        ) : props.mode === "bound" ? (
          <CheckIcon />
        ) : props.mode === "confirm" ? (
          <ShieldCheckIcon />
        ) : (
          <SearchIcon />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-bold tracking-tight text-slate-900">
          {title}
        </div>
        <div className="mt-1 text-xs leading-relaxed text-slate-600">
          {sub}
        </div>
      </div>
      <button
        type="button"
        onClick={props.onClose}
        className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        aria-label="Close"
      >
        <CloseIcon />
      </button>
    </div>
  );
}

// ─── Tabs ───────────────────────────────────────────────────────────────────

function ModalTabs(props: {
  mode: PlanSearchModalMode;
  onSwitchSearch: () => void;
  onSwitchUpload: () => void;
}) {
  const searchActive = props.mode === "search" || props.mode === "auto";
  const uploadActive = props.mode === "upload";
  return (
    <div className="flex gap-1 border-b border-slate-100 bg-white px-4 pt-2">
      <button
        type="button"
        onClick={props.onSwitchSearch}
        className={`relative inline-flex items-center gap-1.5 rounded-t-lg px-3 py-2.5 text-xs font-medium ${
          searchActive
            ? "text-blue-700 after:absolute after:bottom-[-1px] after:left-3 after:right-3 after:h-0.5 after:rounded-full after:bg-blue-600"
            : "text-slate-500 hover:text-slate-700"
        }`}
      >
        <SearchIconSm />
        Search library
      </button>
      <button
        type="button"
        onClick={props.onSwitchUpload}
        className={`relative inline-flex items-center gap-1.5 rounded-t-lg px-3 py-2.5 text-xs font-medium ${
          uploadActive
            ? "text-blue-700 after:absolute after:bottom-[-1px] after:left-3 after:right-3 after:h-0.5 after:rounded-full after:bg-blue-600"
            : "text-slate-500 hover:text-slate-700"
        }`}
      >
        <UploadIconSm />
        Upload my plan
      </button>
    </div>
  );
}

// ─── Auto strip notice ──────────────────────────────────────────────────────

function AutoStripNotice(props: {
  searching: boolean;
  best: SearchResult | null;
  resultsCount: number;
  insurerClause: string;
  billYear: number;
  yearAutoRelaxed: boolean;
}) {
  return (
    <div className="mx-6 mt-4 flex items-start gap-2 rounded-xl border border-blue-100 bg-blue-50 px-3 py-2.5 text-xs text-blue-900">
      <span className="mt-0.5 shrink-0 text-blue-600">
        {props.searching ? <SpinnerIcon /> : props.best ? <SparkleIcon /> : <CheckCircleIcon />}
      </span>
      <span className="leading-relaxed">
        {props.searching ? (
          <>
            Scanning Candid&apos;s library for{" "}
            <strong>
              {props.insurerClause} {props.billYear}
            </strong>{" "}
            plans…
          </>
        ) : props.best ? (
          <>
            Likely match: <strong>{props.best.name}</strong>. Confirm below — or
            pick a different {props.insurerClause} {props.billYear} plan from
            the list.
          </>
        ) : props.yearAutoRelaxed ? (
          <>
            No {props.billYear} {props.insurerClause} plans in the library — showing all years instead.
          </>
        ) : props.resultsCount > 0 ? (
          <>
            Found <strong>{props.resultsCount}</strong> {props.insurerClause}{" "}
            {props.billYear} {props.resultsCount === 1 ? "plan" : "plans"} in the
            library. Pick the closest match to your {props.billYear} coverage.
          </>
        ) : (
          <>
            No {props.insurerClause} {props.billYear} plans in the library yet.
            Try the Upload tab or refine the search.
          </>
        )}
      </span>
    </div>
  );
}

// ─── Search composer (single input + chips, sticky) ─────────────────────────

function SearchStack(props: {
  mode: "auto" | "search";
  query: string;
  setQuery: (q: string) => void;
  filters: Filters;
  billYear: number;
  setInsurerFilter: (v: string | null) => void;
  setYearFilter: (v: number | null) => void;
  setStateFilter: (v: string | null) => void;
  resultsCount: number;
  searching: boolean;
  getAuthToken: () => Promise<string | null>;
  yearAutoRelaxed: boolean;
  onReapplyYear: () => void;
}) {
  return (
    <div className="sticky top-0 z-10 flex flex-col gap-3 border-b border-slate-100 bg-white px-6 pt-4 pb-3">
      <SearchInput
        query={props.query}
        setQuery={props.setQuery}
        placeholder={
          props.mode === "auto"
            ? 'e.g. "Open Access" or "POS"'
            : 'Try "Silver", "Open Access", "Bronze HSA"…'
        }
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <InsurerChip
          value={props.filters.insurerName}
          onChange={props.setInsurerFilter}
          getAuthToken={props.getAuthToken}
        />
        <YearChip
          value={props.filters.year}
          billYear={props.billYear}
          onChange={props.setYearFilter}
        />
        <StateChip
          value={props.filters.state}
          onChange={props.setStateFilter}
        />
        {props.yearAutoRelaxed && (
          <button
            type="button"
            onClick={props.onReapplyYear}
            className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-700 hover:bg-amber-100"
          >
            Re-apply year {props.billYear}
          </button>
        )}
        <div className="flex-1" />
        <span className="text-[11px] text-slate-500">
          {props.searching
            ? "…"
            : `${props.resultsCount} ${props.resultsCount === 1 ? "result" : "results"}`}
        </span>
      </div>
    </div>
  );
}

function SearchInput(props: {
  query: string;
  setQuery: (q: string) => void;
  placeholder: string;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 focus-within:border-blue-400 focus-within:bg-white focus-within:ring-4 focus-within:ring-blue-500/10">
      <span className="shrink-0 text-slate-400">
        <SearchIcon />
      </span>
      <input
        type="text"
        value={props.query}
        onChange={(e) => props.setQuery(e.target.value)}
        placeholder={props.placeholder}
        // autoFocus is fine here — input is mounted only when the modal opens
        // in search/auto mode, so the focus fires once per modal-open per tab
        // switch (matches user expectation for typing immediately).
        autoFocus
        className="min-w-0 flex-1 bg-transparent text-sm text-slate-900 placeholder-slate-400 focus:outline-none"
      />
      {props.query && (
        <button
          type="button"
          onClick={() => props.setQuery("")}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          aria-label="Clear"
        >
          <CloseIconSm />
        </button>
      )}
    </div>
  );
}

// ─── Filter chips ───────────────────────────────────────────────────────────

function InsurerChip(props: {
  value: string | null;
  onChange: (v: string | null) => void;
  getAuthToken: () => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<InsurerOption[]>([]);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // All setOptions() calls live inside the debounce callback so React's
    // react-hooks/set-state-in-effect lint rule passes (effect body itself
    // doesn't synchronously call setState).
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (cancelled) return;
      const trimmed = query.trim();
      if (trimmed.length < 2) {
        setOptions([]);
        return;
      }
      try {
        const token = await props.getAuthToken();
        if (!token) return;
        const res = await fetch(
          `/api/insurer/search?q=${encodeURIComponent(trimmed)}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!res.ok) return;
        const data = (await res.json()) as { insurers?: InsurerOption[] };
        if (!cancelled) setOptions(data.insurers ?? []);
      } catch {
        if (!cancelled) setOptions([]);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, open, props]);

  const active = props.value != null;
  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium ${
          active
            ? "border-blue-200 bg-blue-50 text-blue-700"
            : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50"
        }`}
      >
        <span className={active ? "text-blue-600" : "text-slate-500"}>
          Insurer
        </span>
        <span>{props.value ?? "Any"}</span>
        <ChevronIcon />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-72 rounded-xl border border-slate-200 bg-white p-2 shadow-lg">
          <div className="flex items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-1.5">
            <SearchIconSm />
            <input
              type="text"
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Type to search insurers"
              className="min-w-0 flex-1 bg-transparent text-xs focus:outline-none"
            />
          </div>
          <div className="mt-2 max-h-56 overflow-y-auto">
            {active && (
              <button
                type="button"
                onClick={() => {
                  props.onChange(null);
                  setOpen(false);
                }}
                className="w-full rounded-md px-2.5 py-1.5 text-left text-xs text-slate-600 hover:bg-slate-50"
              >
                Clear (Any)
              </button>
            )}
            {options.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => {
                  props.onChange(opt.name);
                  setOpen(false);
                }}
                className="block w-full rounded-md px-2.5 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50"
              >
                {opt.name}
              </button>
            ))}
            {!options.length && query.trim().length >= 2 && (
              <p className="px-2.5 py-2 text-xs text-slate-500">
                No matches in catalog.
              </p>
            )}
            {!options.length && query.trim().length < 2 && (
              <p className="px-2.5 py-2 text-xs text-slate-500">
                Type 2+ characters to search.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function YearChip(props: {
  value: number | null;
  billYear: number;
  onChange: (v: number | null) => void;
}) {
  const active = props.value != null;
  // Show bill year ± 3 years as quick options
  const yearOptions = [
    props.billYear - 3,
    props.billYear - 2,
    props.billYear - 1,
    props.billYear,
    props.billYear + 1,
  ];
  return (
    <label
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium ${
        active
          ? "border-blue-200 bg-blue-50 text-blue-700"
          : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50"
      }`}
    >
      <span className={active ? "text-blue-600" : "text-slate-500"}>Year</span>
      <select
        value={props.value ?? ""}
        onChange={(e) =>
          props.onChange(e.target.value ? Number(e.target.value) : null)
        }
        className="cursor-pointer appearance-none bg-transparent pr-1 focus:outline-none"
      >
        <option value="">Any</option>
        {yearOptions.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
    </label>
  );
}

function StateChip(props: {
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const active = props.value != null;
  return (
    <label
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium ${
        active
          ? "border-blue-200 bg-blue-50 text-blue-700"
          : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50"
      }`}
    >
      <span className={active ? "text-blue-600" : "text-slate-500"}>State</span>
      <select
        value={props.value ?? ""}
        onChange={(e) => props.onChange(e.target.value || null)}
        className="cursor-pointer appearance-none bg-transparent pr-1 focus:outline-none"
      >
        <option value="">Any</option>
        {US_STATES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    </label>
  );
}

// ─── Results list ───────────────────────────────────────────────────────────

function ResultsList(props: {
  results: SearchResult[];
  searching: boolean;
  searchExecuted: boolean;
  bestMatchId: string | null;
  query: string;
  onSelect: (r: SearchResult) => void;
  onSwitchToUpload: () => void;
}) {
  if (props.searching && props.results.length === 0) {
    return (
      <div className="flex flex-col">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="animate-pulse border-b border-slate-100 px-6 py-4"
          >
            <div className="h-3 w-3/5 rounded bg-slate-200" />
            <div className="mt-2 h-2.5 w-2/5 rounded bg-slate-200" />
          </div>
        ))}
      </div>
    );
  }

  if (props.results.length === 0 && props.searchExecuted) {
    const explicit = props.query.trim().length > 2;
    return (
      <div className="flex flex-col items-center px-6 py-10 text-center">
        <div
          className={`mb-3 flex h-14 w-14 items-center justify-center rounded-2xl ${
            explicit
              ? "bg-amber-50 text-amber-700"
              : "bg-slate-100 text-slate-500"
          }`}
        >
          {explicit ? <QuestionIconLg /> : <DocIconLg />}
        </div>
        <p className="text-sm font-semibold text-slate-900">
          {explicit
            ? "No matching plans in Candid's library"
            : "Refine your search"}
        </p>
        <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-slate-600">
          {explicit
            ? `We don't have a community-corroborated canonical for "${props.query.trim()}" with your current filters. Uploading your plan document is the most accurate path.`
            : "Try a plan name, metal level, or carrier. Filters are optional — leave blank to see broader matches."}
        </p>
        {explicit && (
          <button
            type="button"
            onClick={props.onSwitchToUpload}
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-700"
          >
            <UploadIconSm /> Upload my plan
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {props.results.map((r) => {
        const isBest = r.canonicalPlanId === props.bestMatchId;
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => props.onSelect(r)}
            className={`group relative flex items-center justify-between gap-3 border-b border-slate-100 px-6 py-3.5 text-left transition-colors hover:bg-slate-50 ${
              isBest
                ? "border-blue-100 bg-gradient-to-b from-blue-50/60 to-blue-50 hover:from-blue-50 hover:to-blue-100/80"
                : ""
            }`}
          >
            {isBest && (
              <span className="absolute inset-y-0 left-0 w-0.5 bg-gradient-to-b from-blue-500 to-blue-700" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="truncate text-sm font-semibold text-slate-900">
                  {r.name}
                </span>
                {isBest && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-gradient-to-br from-blue-600 to-blue-700 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white shadow-sm">
                    <SparkleIconSm /> Best match
                  </span>
                )}
                <VerificationBadge level={r.badgeLevel} />
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                <span>{r.insurerName || "Insurer unknown"}</span>
                {r.year != null && (
                  <>
                    <span className="h-0.5 w-0.5 rounded-full bg-slate-300" />
                    <span>{r.year}</span>
                  </>
                )}
                {r.state && (
                  <>
                    <span className="h-0.5 w-0.5 rounded-full bg-slate-300" />
                    <span>{r.state}</span>
                  </>
                )}
                {r.metalLevel && (
                  <>
                    <span className="h-0.5 w-0.5 rounded-full bg-slate-300" />
                    <span>{capitalize(r.metalLevel)}</span>
                  </>
                )}
                {r.type && (
                  <>
                    <span className="h-0.5 w-0.5 rounded-full bg-slate-300" />
                    <span>{r.type}</span>
                  </>
                )}
              </div>
            </div>
            <span
              className={`inline-flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-semibold ${
                isBest
                  ? "bg-blue-600 text-white"
                  : "border border-slate-200 bg-white text-slate-700 group-hover:border-blue-300 group-hover:text-blue-700"
              }`}
            >
              Use this plan <ChevronIcon />
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Confirm / bound / upload panes ─────────────────────────────────────────

function ConfirmPane(props: {
  result: SearchResult;
  binding: boolean;
  bindError: string | null;
}) {
  const r = props.result;
  return (
    <div className="space-y-3 px-6 py-5">
      <div className="rounded-2xl border border-blue-200 bg-gradient-to-b from-white to-blue-50/50 p-5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-slate-900">{r.name}</p>
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
              <span>{r.insurerName || "Insurer unknown"}</span>
              {r.year != null && (
                <>
                  <span className="h-0.5 w-0.5 rounded-full bg-slate-300" />
                  <span>{r.year}</span>
                </>
              )}
              {r.state && (
                <>
                  <span className="h-0.5 w-0.5 rounded-full bg-slate-300" />
                  <span>{r.state}</span>
                </>
              )}
              {r.metalLevel && (
                <>
                  <span className="h-0.5 w-0.5 rounded-full bg-slate-300" />
                  <span>
                    {capitalize(r.metalLevel)} {r.type ?? ""}
                  </span>
                </>
              )}
            </p>
          </div>
          <VerificationBadge level={r.badgeLevel} />
        </div>
      </div>
      <div className="flex items-start gap-2 text-xs leading-relaxed text-slate-600">
        <span className="mt-0.5 text-blue-600">
          <SparkleIconSm />
        </span>
        <span>
          Once selected, your closing argument will cite this plan&apos;s
          cost-sharing terms (community-corroborated) instead of the statutory
          §503-1(g) reverse-burden framing.
        </span>
      </div>
      {props.bindError && (
        <div className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {props.bindError}
        </div>
      )}
    </div>
  );
}

function BoundFlash(props: { result: SearchResult }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-50 to-emerald-100 text-emerald-700 ring-1 ring-inset ring-emerald-200">
        <CheckIcon />
      </div>
      <p className="text-sm font-bold tracking-tight text-slate-900">
        Citing {props.result.insurerName} · {props.result.name}{" "}
        {props.result.year ?? ""}
      </p>
      <p className="mt-1.5 max-w-md text-xs leading-relaxed text-slate-600">
        Regenerating your dispute letter with the bound plan&apos;s
        cost-sharing terms…
      </p>
    </div>
  );
}

function UploadPane(props: {
  billYear: number;
  uploadStage: "idle" | "uploading" | "parsing" | "done" | "error";
  uploadFile: File | null;
  uploadError: string | null;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
  onFileChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onRetry: () => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  // S322 — the size hint derives from the live admin-tuned limit.
  const uploadLimits = useUploadLimits();
  const maxFileMb = Math.round(effectiveClientMaxBytes(uploadLimits) / 1024 / 1024);
  return (
    <div className="px-6 py-5">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          setDragOver(false);
          props.onDrop(e);
        }}
        className={`flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
          dragOver
            ? "border-blue-400 bg-blue-50"
            : "border-slate-200 bg-slate-50/50"
        }`}
      >
        <div className="flex h-13 w-13 items-center justify-center rounded-2xl bg-blue-50 text-blue-600 ring-1 ring-inset ring-blue-100">
          {props.uploadStage === "uploading" || props.uploadStage === "parsing" ? (
            <SpinnerIconLg />
          ) : props.uploadStage === "done" ? (
            <CheckIcon />
          ) : props.uploadStage === "error" ? (
            <WarnIcon />
          ) : (
            <UploadIconLg />
          )}
        </div>
        <p className="text-sm font-semibold text-slate-900">
          {props.uploadStage === "uploading"
            ? `Uploading ${props.uploadFile?.name ?? "your document"}…`
            : props.uploadStage === "parsing"
              ? "Parsing your plan document…"
              : props.uploadStage === "done"
                ? "Document parsed"
                : props.uploadStage === "error"
                  ? "Upload failed"
                  : `Drop your ${props.billYear} plan document here`}
        </p>
        <p className="max-w-sm text-xs leading-relaxed text-slate-600">
          {props.uploadStage === "idle"
            ? `PDF up to ${maxFileMb} MB. The Summary of Benefits and Coverage (SBC) is enough — full plan booklet works too.`
            : props.uploadStage === "parsing"
              ? "Extracting cost-sharing terms locally. This usually takes a few seconds."
              : props.uploadStage === "done"
                ? "Cited terms ready to bind into your letter."
                : props.uploadStage === "error"
                  ? (props.uploadError ?? "Please try again.")
                  : ""}
        </p>
        {props.uploadStage === "idle" && (
          <>
            <span className="text-[11px] text-slate-400">or</span>
            <label className="cursor-pointer rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:border-slate-300">
              Browse files
              <input
                type="file"
                accept=".pdf,application/pdf"
                onChange={props.onFileChange}
                className="hidden"
              />
            </label>
          </>
        )}
        {props.uploadStage === "error" && (
          <button
            type="button"
            onClick={props.onRetry}
            className="rounded-lg border border-blue-300 bg-white px-3.5 py-2 text-xs font-semibold text-blue-700 hover:bg-blue-50"
          >
            Try a different file
          </button>
        )}
      </div>
      <p className="mt-3.5 text-center text-[11px] leading-relaxed text-slate-500">
        Your document stays on Candid&apos;s HIPAA-eligible servers. We extract
        cost-sharing terms, never share the file.
      </p>
    </div>
  );
}

// ─── Footer ─────────────────────────────────────────────────────────────────

function ModalFooter(props: {
  mode: PlanSearchModalMode;
  onSkipToProxy: () => void;
  onBackToSearch: () => void;
  onConfirm: () => void;
  onBackToConfirm: () => void;
  binding: boolean;
}) {
  if (props.mode === "auto" || props.mode === "search") {
    return (
      <div className="flex items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/60 px-6 py-3">
        <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-500">
          <kbd className="rounded-md border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-600">
            ↵
          </kbd>
          select
          <kbd className="ml-1 rounded-md border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-600">
            esc
          </kbd>
          close
        </span>
        {/* S111 smoke #4 — unified copy across auto + search modes. The
            former "Skip — use statutory framing" wording was misleading
            (the proxy path is materially stronger than statutory-only) and
            inconsistent with the strip's button copy. Behavior also unified:
            invoke onSkipToProxy (POST acceptedProxy=true via parent) so the
            strip transitions to bound-proxy. */}
        <button
          type="button"
          onClick={props.onSkipToProxy}
          className="rounded-md px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-200 hover:text-slate-900"
        >
          Use current plan as evidence (weaker)
        </button>
      </div>
    );
  }
  if (props.mode === "upload") {
    return (
      <div className="flex items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/60 px-6 py-3">
        <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-500">
          <ShieldCheckIconSm /> HIPAA-eligible, never shared.
        </span>
        <button
          type="button"
          onClick={props.onBackToSearch}
          className="rounded-md px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-200 hover:text-slate-900"
        >
          Back to library search
        </button>
      </div>
    );
  }
  if (props.mode === "confirm") {
    return (
      <div className="flex items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/60 px-6 py-3">
        <button
          type="button"
          onClick={props.onBackToConfirm}
          className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-200 hover:text-slate-900"
        >
          <ArrowLeftIcon /> Pick a different plan
        </button>
        <button
          type="button"
          onClick={props.onConfirm}
          disabled={props.binding}
          className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-blue-700 disabled:bg-blue-300"
        >
          {props.binding ? "Binding…" : "Use this plan"}
          <ChevronIcon />
        </button>
      </div>
    );
  }
  return null;
}

// ─── Verification badge (shared) ────────────────────────────────────────────

function VerificationBadge({ level }: { level: BadgeLevel }) {
  if (level === "verified") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 ring-1 ring-inset ring-emerald-200">
        <CheckIconXs /> Verified
      </span>
    );
  }
  if (level === "community") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-700 ring-1 ring-inset ring-blue-200">
        Community
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 ring-1 ring-inset ring-amber-200">
      Estimated
    </span>
  );
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── Icons ──────────────────────────────────────────────────────────────────

function SearchIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function SearchIconSm() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function UploadIconSm() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function UploadIconLg() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function CloseIconSm() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function ArrowLeftIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function CheckIconXs() {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

function ShieldCheckIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

function ShieldCheckIconSm() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M12 2l1.5 5.5L19 9l-5.5 1.5L12 16l-1.5-5.5L5 9l5.5-1.5L12 2zM19 14l.75 2.5L22 17l-2.25.75L19 20l-.75-2.25L16 17l2.25-.5L19 14zM5 14l.75 2.5L8 17l-2.25.75L5 20l-.75-2.25L2 17l2.25-.5L5 14z" />
    </svg>
  );
}

function SparkleIconSm() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M12 2l1.5 5.5L19 9l-5.5 1.5L12 16l-1.5-5.5L5 9l5.5-1.5L12 2z" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="animate-spin"
      aria-hidden
    >
      <path d="M21 12a9 9 0 11-6.219-8.56" />
    </svg>
  );
}

function SpinnerIconLg() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="animate-spin"
      aria-hidden
    >
      <path d="M21 12a9 9 0 11-6.219-8.56" />
    </svg>
  );
}

function WarnIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function QuestionIconLg() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function DocIconLg() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}
