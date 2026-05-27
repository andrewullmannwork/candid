"use client";

/**
 * Unified parse screen (S100 v3 — universal loader).
 *
 * Per Andrew direction at S100 smoke: ONE screen for every parse phase. No
 * step pills, no Upload→Read→Extract→Save checkmarks, no Cross-referencing
 * distinction. The phase pill (top-right of the card) is the single source
 * of "what's happening right now" signal.
 *
 * Phase pill: Uploading / Parsing / Ready / Couldn't process / Waiting.
 *
 * Progress bar:
 *   - Uploading → driven by uploadProgress (bytes-in-flight 0-100%)
 *   - Parsing   → driven by (displayedPage / totalPages) × 100% via the
 *                 synthetic page-tick mechanic
 *   - Complete  → 100%
 *   - Error     → not shown
 *
 * Page count "Page X of N" renders ONLY during parsing phase + once totalPages
 * is known (it's null during the brief window between upload-complete and the
 * first classifier polling response).
 *
 * Synthetic page-tick mechanic (Andrew direction S100):
 *   - Random interval ∈ {3, 5, 7, 10}s per increment
 *   - Caps at totalPages - 1, HOLDS there until phase === "complete"
 *   - Snap to totalPages on complete (or if backend signals processed before
 *     synthetic reaches the hold)
 *   - Pull-up to backend completedPages ONLY during OCR phase (step includes
 *     ocr_chunk/working_ocr) — Haiku phases don't expose page progress.
 *
 * Serves BOTH /upload (single-doc hero layout) and /compare (multi-doc
 * stacked-card layout). One source of truth; no PlayfulParsingScreen.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { pickNextTickInterval } from "@/lib/parsing/parseProgressUx";
import { StackLoaderV3 } from "@/components/loaders/StackLoaderV3";
import { ROTATING_MICROCOPY, MICROCOPY_INTERVAL_MS } from "@/lib/microcopy/playful-microcopy";

export type ParseDocPhase = "queued" | "uploading" | "parsing" | "complete" | "error";

export interface ParseDoc {
  /** Stable client-side ID used as React key. */
  id: string;
  /** User-visible label ("Your document" / "Plan A" / etc.). */
  label: string;
  /** File name surfaced under the label. */
  fileName: string;
  phase: ParseDocPhase;
  /** 0-100 during uploading phase; ignored otherwise. */
  uploadProgress: number;
  /** Total page count from classifier; null pre-classify. */
  totalPages: number | null;
  /** Backend `processing_step` ("ocr_chunk_0_done", etc.); used only for OCR-phase pull-up. */
  step: string | null;
  /** Backend `completedPages`; used only for OCR-phase pull-up. */
  realCompletedPages: number | null;
  /**
   * S102 — surfaces `documents.metadata.smart_skip_outcome` from the status
   * endpoint. When "skipped", useSyntheticDisplayedPage uses accelerated
   * intervals (250ms page-tick + 500ms sub-phase) so the UI matches the
   * actual ~12s smart-skip backend latency instead of running the full
   * 45-60s animation for a parse that didn't happen.
   */
  smartSkipOutcome?: string | null;
  errorMessage?: string;
}

interface UnifiedParseScreenProps {
  docs: ParseDoc[];
  title?: string;
  subtitle?: string;
  footer?: React.ReactNode;
  onCancel?: () => void;
  /**
   * Fires once every doc's internal sub-phase machine has reached "complete"
   * (i.e., the synthetic ticking → hold → finalizing → syncing → final_steps
   * chain has played out AND the backend has signaled processed). Caller
   * (typically ProcessingFlow) uses this to gate the transition to terminal
   * views — the user always sees the full progression even when the backend
   * finishes fast (S101 v2 — Andrew direction).
   */
  onProgressionComplete?: () => void;
  /**
   * Loader visual variant (B2-UP.1).
   *   - "default" (or omitted): existing doc-card visual; serves /compare
   *     multi-doc stacked-card layout + /upload prior to redesign.
   *   - "stackV3": render the design's StackLoaderV3 visual (5-doc
   *     decorative card stack + page counter + rotating message + hairline
   *     progress). Single-doc only. Sub-phase state machine + S98 tick +
   *     S102 fast-path + onProgressionComplete preserved verbatim — only
   *     the chrome changes.
   */
  loaderVariant?: "default" | "stackV3";
}

// B-LOAD.1 (S131): single source of truth for rotating microcopy. The
// previously-inline ROTATING_MICROCOPY (55 lines, S93 lock) + narrow stackV3
// AUDIT/PLAN palettes (5 lines each) consolidated into
// `src/lib/microcopy/playful-microcopy.ts` per Andrew direction "use the
// 40 or so playful texts we had on the old loader" for the stackV3 variant too.
// Logic preserved: rotation interval + cycling effect at line 732 unchanged.

// ─── Phase derivation (exported helper for callers) ─────────────────────────

interface DerivePhaseInput {
  uploadStatus:
    | "uploading"
    | "uploaded"
    | "auto_processed"
    | "pending_review"
    | "rejected"
    | "dedup_processed"
    | "awaiting_confirmation"
    | null;
  processingProgress: {
    status?: string;
    isStuck?: boolean;
    /** Backend `processing_total_pages`. 0/undefined while classifier is still
     *  determining; > 0 once known. Gates the "Uploading" → "Parsing" pill
     *  transition per the S101 two-flow model. */
    totalPages?: number;
  } | null;
  /** 0-100 — bytes uploaded so far for the in-flight XHR. Accepted for callers'
   *  convenience; not used in the current derivation (uploadStatus alone gates
   *  the byte-upload window). */
  uploadProgress: number;
}

/**
 * Two-flow phase derivation (Andrew direction S101).
 *
 * Two clean flows, one transition trigger:
 *   Flow 1 (auto-accept): byte upload → "Uploading" pill + "Reading…" status →
 *     classifier finishes + pageCount known → "Parsing" pill + "Page 0 of N"
 *   Flow 2 (modal): byte upload → "Uploading" + "Reading…" → classifier
 *     disagrees → modal (handled by ProcessingFlow priority 0) → user picks →
 *     "Parsing" pill + "Page 0 of N" using the pageCount already in hand
 *
 * The "Uploading" pill stays visible until BOTH:
 *   (a) we're past the upload XHR (uploadStatus !== "uploading"), AND
 *   (b) pageCount is known (processingProgress.totalPages > 0)
 *
 * The (b) gate eliminates the "Reading…" stuck-state bug from S100 smoke at
 * its source — we never render a page-counted screen with an unknown N.
 * Once seeded (from uploadResult.classification.pageCount on auto-accept OR
 * from confirmationData.page_count on modal confirm), the page-tick screen
 * appears immediately at "Page 0 of N".
 *
 * uploadProgress is no longer part of the derivation — uploadStatus alone
 * gates the byte-upload window. The S100 v3 `uploadProgress < 100` fast-skip
 * was the bug source: it transitioned the pill to "Parsing" the moment bytes
 * settled, while pageCount was still unknown, producing the "Reading…" loop.
 */
export function derivePhase(input: DerivePhaseInput): ParseDocPhase {
  const { uploadStatus, processingProgress } = input;
  if (processingProgress?.status === "processed") return "complete";
  if (processingProgress?.status === "error" || processingProgress?.isStuck) return "error";
  if (uploadStatus === "uploading") return "uploading";
  const hasPageCount = (processingProgress?.totalPages ?? 0) > 0;
  if (!hasPageCount) return "uploading";
  return "parsing";
}

// ─── Synthetic-tick hook (per-doc; internal to UnifiedParseScreen) ──────────

/**
 * Sub-phase state machine for the parsing display (Andrew direction S100 v3):
 *
 *   ticking      → page counter increments 1 → N at random {3,5,7,10}s
 *   hold         → "Page N of N" held for 10s after counter reaches N
 *   finalizing   → "Finalizing Parse" for 15s
 *   syncing      → "Syncing to Profile" for 20s
 *   final_steps  → "Final Steps" indefinite until backend signals complete
 *   complete     → terminal (parent unmounts via priority-8/9 dispatch)
 *
 * Skip-to-complete rule: at ANY sub-phase, if `doc.phase === "complete"`,
 * cancel all timers + snap counter to N + transition to "complete" immediately.
 * Total synthetic timeline before "Final Steps": ~6N + 45 seconds.
 */
export type SubPhase = "ticking" | "hold" | "finalizing" | "syncing" | "final_steps" | "complete";

interface SyntheticState {
  displayedPage: number;
  subPhase: SubPhase;
}

// S101 v4 — sub-phase timing uses MIN/MAX bands instead of fixed durations.
// Each sub-phase shows for at LEAST SUB_PHASE_MIN_MS so the user reads the
// label. After that, if backend has signaled processed, advance immediately;
// otherwise hold up to the MAX (the original v3 fixed value). Result: fast
// backends (1-page bills) finish the chrome in ~2.5s/phase instead of
// 10/15/20s; slow backends still get the full timeline.
const SUB_PHASE_MIN_MS = 2_500;
const HOLD_MAX_MS = 10_000;
const FINALIZING_MAX_MS = 15_000;
const SYNCING_MAX_MS = 20_000;
// Final Steps has only a MIN — it's gated on backend completion, then sticks
// for FINAL_STEPS_MIN_MS so the label is actually readable.
const FINAL_STEPS_MIN_MS = 3_000;

// S102 — smart-skip fast path constants. When ParseDoc.smartSkipOutcome ===
// "skipped" (backend signaled no Haiku parse ran), every sub-phase uses these
// shorter durations. Page-tick interval is in parseProgressUx.ts
// (SMART_SKIP_TICK_INTERVAL_MS = 250ms). Total animation budget for an 8-page
// smart-skip: ~2s page-tick + ~2s sub-phases = ~4s — matches the ~12s
// backend latency closely without skipping the visual progress entirely.
const SMART_SKIP_SUB_PHASE_MS = 500;

function computeSubPhaseRemaining(
  startedAt: number,
  backendDone: boolean,
  maxMs: number,
  accelerated: boolean,
): number {
  const elapsed = Date.now() - startedAt;
  if (accelerated) {
    // Smart-skip path: every sub-phase shows for 500ms regardless of backend
    // completion timing. Backend usually beats us (parse already done before
    // ticking finishes), so the user sees the snap-to-complete via the
    // existing FINAL_STEPS_MIN_MS gate path.
    return Math.max(0, SMART_SKIP_SUB_PHASE_MS - elapsed);
  }
  const targetMs = backendDone ? SUB_PHASE_MIN_MS : maxMs;
  return Math.max(0, targetMs - elapsed);
}

function useSyntheticDisplayedPage(doc: ParseDoc): SyntheticState {
  // React 19 idiomatic: setState-during-render with equality guards for the
  // prop-derived state transitions; setTimeout-callback setState for the timers.
  const [displayedPage, setDisplayedPage] = useState(0);
  const [lastTotalPages, setLastTotalPages] = useState<number | null>(null);
  const [subPhase, setSubPhase] = useState<SubPhase>("ticking");

  // S102 — accelerated UI when backend signaled smart-skip. Gate on doc field
  // surfaced via /api/documents/status. Null/undefined → existing behavior;
  // only "skipped" triggers fast path.
  const accelerated = doc.smartSkipOutcome === "skipped";

  // Reset on totalPages change (during render with equality guard). Starts at
  // 0 so the user sees "Page 0 of N" immediately on first render — the tick
  // increments to 1 after the first interval.
  if (doc.totalPages !== lastTotalPages) {
    setLastTotalPages(doc.totalPages);
    setDisplayedPage(0);
    setSubPhase("ticking");
  }

  // S101 v3 — the sub-phase machine runs its FULL progression on its own
  // timers, regardless of how fast the backend finishes. For a 1-page bill
  // that parses in 5s, the user still sees:
  //   ticking (3-10s × N) → hold (10s) → finalizing (15s) → syncing (20s)
  //   → final_steps (≥3s; longer if backend hasn't acked yet)
  // "Final Steps" is the only sub-phase that observes backend status — it
  // transitions to "complete" only after BOTH the FINAL_STEPS_MIN_MS floor
  // AND doc.phase === "complete" (backend signaled processed). That transition
  // is owned by the timer effect below — NOT a during-render setState, which
  // would fire in a single frame and never give the user time to see the
  // "Final Steps" label.

  // OCR-phase pull-up (only valid during the ticking sub-phase; once we
  // transition to hold/finalizing/syncing/final_steps, displayedPage is at N
  // and backend completedPages is irrelevant).
  const isOcrPhase =
    doc.step?.includes("ocr_chunk") === true ||
    doc.step?.includes("working_ocr") === true;
  if (
    subPhase === "ticking" &&
    isOcrPhase &&
    doc.totalPages != null &&
    doc.totalPages >= 1 &&
    doc.realCompletedPages != null
  ) {
    const target = Math.min(doc.realCompletedPages, doc.totalPages);
    if (target > displayedPage) {
      setDisplayedPage(target);
    }
  }

  // Transition ticking → hold once the counter reaches N (during render with
  // equality guard).
  if (
    subPhase === "ticking" &&
    doc.totalPages != null &&
    doc.totalPages > 0 &&
    displayedPage >= doc.totalPages
  ) {
    setSubPhase("hold");
  }

  // Random-pace synthetic tick @ {3, 5, 7, 10}s. Caps at totalPages — when
  // the increment hits N, the during-render guard above transitions to hold.
  //
  // S101 v3 — the ticker runs purely on its own timer chain, INDEPENDENT of
  // doc.phase. Even if backend signals processed mid-tick, we keep ticking
  // until we reach N (Andrew direction: user must see the page counter play
  // out). doc.phase deliberately NOT in deps — including it caused the timer
  // to restart whenever backend flipped to "complete", effectively pausing
  // the ticker. ProcessingFlow priority 4 catches error states upstream so
  // UnifiedParseScreen never renders for an errored doc anyway.
  useEffect(() => {
    if (subPhase !== "ticking") return;
    if (doc.totalPages == null || doc.totalPages < 1) return;
    const ceiling = doc.totalPages;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const scheduleNext = () => {
      if (cancelled) return;
      const delay = pickNextTickInterval(accelerated);
      timeoutId = setTimeout(() => {
        if (cancelled) return;
        setDisplayedPage((prev) => Math.min(prev + 1, ceiling));
        scheduleNext();
      }, delay);
    };
    scheduleNext();
    return () => {
      cancelled = true;
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
  }, [doc.totalPages, subPhase, accelerated]);

  // Per-sub-phase start-time refs. Used to compute "remaining time" when
  // doc.phase flips mid-sub-phase, so we can shorten to MIN-from-start
  // without restarting the timer (which would otherwise double the visible
  // duration). Cleared when sub-phase exits.
  const holdStartedAtRef = useRef<number | null>(null);
  const finalizingStartedAtRef = useRef<number | null>(null);
  const syncingStartedAtRef = useRef<number | null>(null);
  const finalStepsStartedAtRef = useRef<number | null>(null);

  // Hold → Finalizing. S101 v4 MIN/MAX: shows for at least 2.5s; advances
  // immediately once both MIN elapsed AND backend done; otherwise holds for
  // the full 10s. doc.phase IS in deps so the timer recomputes when backend
  // flips to "complete" mid-hold — the elapsed-from-startedAt computation
  // makes the new timer fire at max(0, MIN - elapsed) instead of restarting
  // from scratch (avoiding the v2 double-hold bug).
  useEffect(() => {
    if (subPhase !== "hold") {
      holdStartedAtRef.current = null;
      return;
    }
    if (holdStartedAtRef.current === null) {
      holdStartedAtRef.current = Date.now();
    }
    const remaining = computeSubPhaseRemaining(
      holdStartedAtRef.current,
      doc.phase === "complete",
      HOLD_MAX_MS,
      accelerated,
    );
    const t = setTimeout(() => setSubPhase("finalizing"), remaining);
    return () => clearTimeout(t);
  }, [subPhase, doc.phase, accelerated]);

  // Finalizing → Syncing. Same MIN/MAX pattern as hold.
  useEffect(() => {
    if (subPhase !== "finalizing") {
      finalizingStartedAtRef.current = null;
      return;
    }
    if (finalizingStartedAtRef.current === null) {
      finalizingStartedAtRef.current = Date.now();
    }
    const remaining = computeSubPhaseRemaining(
      finalizingStartedAtRef.current,
      doc.phase === "complete",
      FINALIZING_MAX_MS,
      accelerated,
    );
    const t = setTimeout(() => setSubPhase("syncing"), remaining);
    return () => clearTimeout(t);
  }, [subPhase, doc.phase, accelerated]);

  // Syncing → Final Steps. Same MIN/MAX pattern.
  useEffect(() => {
    if (subPhase !== "syncing") {
      syncingStartedAtRef.current = null;
      return;
    }
    if (syncingStartedAtRef.current === null) {
      syncingStartedAtRef.current = Date.now();
    }
    const remaining = computeSubPhaseRemaining(
      syncingStartedAtRef.current,
      doc.phase === "complete",
      SYNCING_MAX_MS,
      accelerated,
    );
    const t = setTimeout(() => setSubPhase("final_steps"), remaining);
    return () => clearTimeout(t);
  }, [subPhase, doc.phase, accelerated]);

  // Final Steps → Complete: gated on backend signal (doc.phase === "complete")
  // plus FINAL_STEPS_MIN_MS floor. If backend completes before final_steps
  // even starts, this fires the 3s timer the moment the syncing→final_steps
  // transition lands. If backend isn't done yet, no timer runs — we wait.
  useEffect(() => {
    if (subPhase !== "final_steps") {
      finalStepsStartedAtRef.current = null;
      return;
    }
    if (finalStepsStartedAtRef.current === null) {
      finalStepsStartedAtRef.current = Date.now();
    }
    if (doc.phase !== "complete") return;
    const elapsed = Date.now() - finalStepsStartedAtRef.current;
    const remaining = Math.max(0, FINAL_STEPS_MIN_MS - elapsed);
    const t = setTimeout(() => {
      setSubPhase("complete");
      if (doc.totalPages != null && doc.totalPages > 0) {
        setDisplayedPage(doc.totalPages);
      }
    }, remaining);
    return () => clearTimeout(t);
  }, [subPhase, doc.phase, doc.totalPages]);

  return { displayedPage, subPhase };
}

// ─── Phase visualization helpers ────────────────────────────────────────────

function PhaseLabel({ phase }: { phase: ParseDocPhase }) {
  const labels: Record<ParseDocPhase, string> = {
    queued: "Waiting",
    uploading: "Uploading",
    parsing: "Parsing",
    complete: "Ready",
    error: "Couldn't process",
  };
  const colors: Record<ParseDocPhase, string> = {
    queued: "text-slate-500",
    uploading: "text-blue-600",
    parsing: "text-blue-600",
    complete: "text-emerald-600",
    error: "text-rose-600",
  };
  return <span className={`text-xs font-semibold ${colors[phase]}`}>{labels[phase]}</span>;
}

function PhaseIcon({ phase }: { phase: ParseDocPhase }) {
  if (phase === "complete") {
    return (
      <div className="w-9 h-9 rounded-full bg-emerald-100 flex items-center justify-center">
        <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </div>
    );
  }
  if (phase === "error") {
    return (
      <div className="w-9 h-9 rounded-full bg-rose-100 flex items-center justify-center">
        <svg className="w-5 h-5 text-rose-600" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </div>
    );
  }
  if (phase === "queued") {
    return (
      <div className="w-9 h-9 rounded-full bg-slate-100 flex items-center justify-center">
        <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" strokeDasharray="3 3" />
        </svg>
      </div>
    );
  }
  // uploading / parsing — animated.
  return (
    <div className="w-9 h-9 rounded-full bg-blue-100 flex items-center justify-center">
      <svg className="w-5 h-5 text-blue-600 animate-spin" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
        <path strokeLinecap="round" d="M12 3a9 9 0 019 9" />
      </svg>
    </div>
  );
}

// ─── Doc card (one per doc in the array) ────────────────────────────────────

// Sub-phase status text mapping (Andrew direction S100 v3). Page count
// "Page X of N" stays visible through "ticking" + "hold"; from "finalizing"
// onward the status text replaces it.
function subPhaseStatusText(subPhase: SubPhase): string | null {
  if (subPhase === "finalizing") return "Finalizing Parse";
  if (subPhase === "syncing") return "Syncing to Profile";
  if (subPhase === "final_steps") return "Final Steps";
  return null;
}

function DocCard({
  doc,
  isHero,
  onSubPhaseChange,
}: {
  doc: ParseDoc;
  isHero: boolean;
  onSubPhaseChange?: (docId: string, subPhase: SubPhase) => void;
}) {
  const { displayedPage, subPhase } = useSyntheticDisplayedPage(doc);

  // Bubble per-doc subPhase changes up to UnifiedParseScreen so it can fire
  // onProgressionComplete when all docs reach "complete" subPhase. Tracking
  // happens at the parent layer because the sub-phase state is per-doc but
  // the completion signal is screen-wide.
  useEffect(() => {
    onSubPhaseChange?.(doc.id, subPhase);
  }, [doc.id, subPhase, onSubPhaseChange]);

  // S101 v2 — effective phase: when backend signals processed but the
  // sub-phase machine is still running, keep showing "Parsing" so the
  // synthetic progression remains visible. Only flip to "complete" once the
  // sub-phase machine itself reaches "complete" (which happens at
  // final_steps + backend-processed per the during-render guard above).
  const effectivePhase: ParseDocPhase =
    doc.phase === "complete" && subPhase !== "complete" ? "parsing" : doc.phase;

  const isActive = effectivePhase === "uploading" || effectivePhase === "parsing";
  const ringColor =
    effectivePhase === "complete"
      ? "ring-emerald-200"
      : effectivePhase === "error"
        ? "ring-rose-200"
        : isActive
          ? "ring-blue-200"
          : "ring-slate-200";

  // Status text (Andrew direction S101 two-flow simplification):
  //   - effectivePhase="uploading" → "Reading…" (byte transfer OR post-upload
  //     classifier wait — single status text spans the entire pre-pageCount
  //     window).
  //   - effectivePhase="parsing" + ticking/hold → "Page X of N".
  //   - effectivePhase="parsing" + post-hold → "Finalizing Parse" / "Syncing
  //     to Profile" / "Final Steps" per the sub-phase machine.
  //   - effectivePhase="complete"/"error" → null (ParseTerminalView takes over
  //     via ProcessingFlow dispatch; doc card never renders these in practice).
  const statusText: string | null = (() => {
    if (effectivePhase === "uploading") return "Reading…";
    if (effectivePhase !== "parsing") return null;
    const staged = subPhaseStatusText(subPhase);
    if (staged) return staged;
    if (doc.totalPages != null && doc.totalPages > 0) {
      return `Page ${displayedPage} of ${doc.totalPages}`;
    }
    // Defensive — derivePhase keeps us in "uploading" while totalPages is
    // unknown, so this branch is unreachable under the new two-flow contract.
    return "Reading…";
  })();

  // Progress bar:
  //   - uploading → uploadProgress (bytes 0-100)
  //   - parsing + ticking → (displayedPage / totalPages) × 100
  //   - parsing + hold/finalizing/syncing/final_steps → 100 (full bar)
  //   - complete → 100
  //   - error → not rendered
  //   - queued → 0 (slate fill)
  const progressBarPct = (() => {
    if (effectivePhase === "uploading") return Math.max(5, doc.uploadProgress);
    if (effectivePhase === "complete") return 100;
    if (effectivePhase === "error") return 0;
    if (effectivePhase === "queued") return 0;
    // parsing
    if (doc.totalPages == null || doc.totalPages < 1) return 8;
    if (subPhase !== "ticking") return 100; // hold + post-hold sub-phases hold the bar full
    return Math.max(5, Math.round((displayedPage / doc.totalPages) * 100));
  })();

  return (
    <div
      className={`p-4 rounded-2xl bg-white ring-1 ${ringColor} transition-all ${
        isActive ? "shadow-sm" : ""
      } ${isHero ? "p-5" : ""}`}
    >
      <div className="flex items-start gap-3">
        <PhaseIcon phase={effectivePhase} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p className={`font-semibold text-slate-900 truncate ${isHero ? "text-base" : "text-sm"}`}>
              {doc.label}
            </p>
            <PhaseLabel phase={effectivePhase} />
          </div>
          <p className="text-xs text-slate-500 truncate mt-0.5">{doc.fileName}</p>
          {effectivePhase === "error" && doc.errorMessage && (
            <p className="text-xs text-rose-600 mt-2 leading-relaxed">{doc.errorMessage}</p>
          )}
          {effectivePhase !== "complete" && effectivePhase !== "error" && (
            <>
              <div className="mt-3 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-700 ${
                    effectivePhase === "queued" ? "bg-slate-300" : "bg-blue-500"
                  }`}
                  style={{ width: `${progressBarPct}%` }}
                />
              </div>
              {/* Status text BELOW the progress bar (Andrew S100 v3). Shows
                  "Page X of N" during ticking/hold, then "Finalizing Parse" /
                  "Syncing to Profile" / "Final Steps" across the post-N
                  sub-phases.
                  Key uses sub-phase identity (not the full text) so per-tick
                  page-count updates ("Page 1 of 8" → "Page 2 of 8") update in
                  place without remounting. Only true category changes
                  (page-count → Finalizing → Syncing → Final Steps) re-key and
                  fade-in. */}
              {statusText && (
                <p
                  key={subPhaseStatusText(subPhase) ?? "page_count"}
                  className="text-sm font-medium text-slate-700 mt-3 animate-fade-in"
                >
                  {statusText}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Screen ─────────────────────────────────────────────────────────────────

export function UnifiedParseScreen({
  docs,
  title,
  subtitle,
  footer,
  onCancel,
  onProgressionComplete,
  loaderVariant = "default",
}: UnifiedParseScreenProps) {
  // NOTE: ALL hooks called unconditionally before the loaderVariant branch
  // below per Rules of Hooks. When loaderVariant === "stackV3", the
  // microcopyIdx + docSubPhases state stays unused — harmless idle state.
  const [microcopyIdx, setMicrocopyIdx] = useState(0);

  // Per-doc subPhase tracking (S101 v2). Each DocCard reports its internal
  // sub-phase via onSubPhaseChange; when all docs hit "complete", we fire
  // onProgressionComplete so the parent can dispatch to terminal views.
  const [docSubPhases, setDocSubPhases] = useState<Record<string, SubPhase>>({});

  const handleSubPhaseChange = useCallback((docId: string, subPhase: SubPhase) => {
    setDocSubPhases((prev) =>
      prev[docId] === subPhase ? prev : { ...prev, [docId]: subPhase },
    );
  }, []);

  useEffect(() => {
    if (!onProgressionComplete) return;
    if (docs.length === 0) return;
    // stackV3 variant owns its own onProgressionComplete wiring inside
    // StackLoaderV3Variant; skip this effect's call path to avoid double-firing.
    if (loaderVariant === "stackV3") return;
    const allComplete = docs.every((d) => docSubPhases[d.id] === "complete");
    if (allComplete) onProgressionComplete();
  }, [docs, docSubPhases, onProgressionComplete, loaderVariant]);

  useEffect(() => {
    const allDone = docs.every((d) => d.phase === "complete" || d.phase === "error");
    if (allDone) return;
    const interval = setInterval(() => {
      setMicrocopyIdx((i) => (i + 1) % ROTATING_MICROCOPY.length);
    }, MICROCOPY_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [docs]);

  // ── stackV3 variant (B2-UP.1 /upload visual refresh) ──────────────────
  // Renders the design's StackLoaderV3 chrome while preserving the existing
  // sub-phase state machine + S98 random-paced tick + S102 fast-path +
  // onProgressionComplete gate. Restricted to single-doc — /compare callers
  // must keep loaderVariant="default" or unset. Branch placed AFTER all
  // hooks to satisfy Rules of Hooks.
  if (loaderVariant === "stackV3" && docs.length === 1) {
    return (
      <StackLoaderV3Variant
        doc={docs[0]}
        title={title}
        footer={footer}
        onCancel={onCancel}
        onProgressionComplete={onProgressionComplete}
      />
    );
  }

  // Effective allComplete: rendered "Ready" header requires the sub-phase
  // machine to have wrapped up, not just the backend. Matches the per-doc
  // effectivePhase rule in DocCard.
  const allComplete = docs.every(
    (d) => d.phase === "complete" && docSubPhases[d.id] === "complete",
  );
  const anyError = docs.some((d) => d.phase === "error");
  const isHero = docs.length === 1;
  const defaultTitle = isHero ? "Reading your document" : "Reading your plan documents";

  return (
    <div className={`max-w-2xl mx-auto ${isHero ? "" : "py-10"} px-4 relative`}>
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel upload"
          className="absolute top-2 left-2 w-9 h-9 flex items-center justify-center rounded-full hover:bg-slate-100 transition-colors text-slate-400 hover:text-slate-700"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}

      <div className="text-center mb-8">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 mb-4 shadow-lg shadow-blue-200">
          <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </div>
        <h1 className="text-2xl font-semibold text-slate-900">{title ?? defaultTitle}</h1>
        {subtitle && (
          <p className="text-sm text-slate-600 mt-2 max-w-md mx-auto leading-relaxed">{subtitle}</p>
        )}
      </div>

      <div className="space-y-3">
        {docs.map((doc) => (
          <DocCard
            key={doc.id}
            doc={doc}
            isHero={isHero}
            onSubPhaseChange={handleSubPhaseChange}
          />
        ))}
      </div>

      {!allComplete && !anyError && (
        <div className="mt-8 text-center min-h-[2.5rem]">
          <p key={microcopyIdx} className="text-sm text-slate-600 animate-fade-in inline-block">
            {ROTATING_MICROCOPY[microcopyIdx]}
          </p>
        </div>
      )}

      {footer && <div className="mt-8">{footer}</div>}

      <style jsx>{`
        @keyframes fade-in {
          from {
            opacity: 0;
            transform: translateY(4px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .animate-fade-in {
          animation: fade-in 600ms ease-out;
        }
      `}</style>
    </div>
  );
}

// ─── stackV3 variant (B2-UP.1) ──────────────────────────────────────────────
//
// Drives the same sub-phase state machine as DocCard (via the shared
// useSyntheticDisplayedPage hook), but renders StackLoaderV3 chrome instead
// of the doc-card UI. Fires onProgressionComplete the moment its single
// doc's subPhase reaches "complete" — same gate semantics as the default
// variant.

function StackLoaderV3Variant({
  doc,
  title,
  footer,
  onCancel,
  onProgressionComplete,
}: {
  doc: ParseDoc;
  title?: string;
  footer?: React.ReactNode;
  onCancel?: () => void;
  onProgressionComplete?: () => void;
}) {
  const { displayedPage, subPhase } = useSyntheticDisplayedPage(doc);

  // S101 v2 — effective phase logic + status-text derivation mirror the
  // default variant exactly. When backend signals processed but the sub-phase
  // machine is still running, keep showing parsing chrome until the machine
  // wraps.
  const effectivePhase: ParseDocPhase =
    doc.phase === "complete" && subPhase !== "complete" ? "parsing" : doc.phase;

  const subPhaseLabel = subPhaseStatusText(subPhase);
  const subPhaseText: string | null = (() => {
    if (effectivePhase === "uploading") return "Reading…";
    if (effectivePhase !== "parsing") return null;
    if (subPhaseLabel) return subPhaseLabel;
    return null; // page counter rendered by StackLoaderV3 when subPhaseText is null
  })();

  // B-LOAD.1 (S131): unified 55-line ROTATING_MICROCOPY for all doc types per
  // Andrew direction. Doc-kind detection retired — the doctor's-office palette
  // works equally for SBC/EOC/plan-doc and EOB/itemized-bill flows. Detection
  // logic preserved for git-blame traceability only.
  const messages = ROTATING_MICROCOPY;

  useEffect(() => {
    if (subPhase === "complete" && onProgressionComplete) {
      onProgressionComplete();
    }
  }, [subPhase, onProgressionComplete]);

  return (
    <StackLoaderV3
      currentPage={displayedPage}
      totalPages={doc.totalPages}
      subPhaseText={subPhaseText}
      title={title ?? "Reading your document"}
      messages={messages}
      footer={footer}
      onCancel={onCancel}
    />
  );
}
