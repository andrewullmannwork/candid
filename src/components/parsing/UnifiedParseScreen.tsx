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
import { useEffect, useState } from "react";
import { pickNextTickInterval } from "@/lib/parsing/parseProgressUx";

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
  errorMessage?: string;
}

interface UnifiedParseScreenProps {
  docs: ParseDoc[];
  title?: string;
  subtitle?: string;
  footer?: React.ReactNode;
  onCancel?: () => void;
}

// Whimsical doctor's-office vignettes. S93 lock: 55 lines, 4s rotation.
const ROTATING_MICROCOPY: string[] = [
  "Taking a pen from behind our ear.",
  "Adjusting the reading lamp on our desk.",
  "Sliding glasses down to the tip of our nose.",
  "Doodling a tiny stethoscope in the margin.",
  "Sharpening a #2 pencil. Just the way we like it.",
  "Highlighting the important bits in yellow.",
  "Adding a sticky note for later.",
  "Pouring a fresh cup of coffee.",
  "Stacking the pages. Aligning pens.",
  "Underlining the fine print twice.",
  "Tapping the desk thoughtfully.",
  "Cross-referencing with the big binder on the shelf.",
  "Drawing a little arrow next to the most important number.",
  "Stamping a smiley face in the corner.",
  "Almost done. Just polishing the apple on the desk.",
  "Squinting at the small print.",
  "Reaching for the second pair of glasses.",
  "Untangling the phone cord.",
  "Filing the folder under “important.”",
  "Wiping a smudge off the desk lamp.",
  "Tearing a fresh page from the notepad.",
  "Clicking the pen twice. Just to be sure.",
  "Pinning a note to the corkboard.",
  "Sliding the manila folder open.",
  "Counting the pages a second time.",
  "Refilling the stapler.",
  "Erasing a faint pencil mark.",
  "Fluffing the cushion on the rolling chair.",
  "Straightening the diploma on the wall.",
  "Watering the office fern.",
  "Reading aloud, just to ourselves.",
  "Reaching for the calculator.",
  "Adjusting the desk fan.",
  "Folding a paper airplane out of habit.",
  "Squaring the corners of the stack.",
  "Writing “TBD” then scratching it out.",
  "Locating the missing paperclip.",
  "Tapping the stapler. Empty.",
  "Refilling the coffee pot.",
  "Brushing crumbs off the manila folder.",
  "Glancing at the wall clock.",
  "Lining up the post-it notes.",
  "Drawing a star next to the deductible.",
  "Re-reading the appendix, just in case.",
  "Cracking our knuckles.",
  "Switching from blue ink to red.",
  "Spotting the typo on page three.",
  "Sliding a bookmark into the right spot.",
  "Sketching a tiny clipboard in the margin.",
  "Whispering “interesting” under our breath.",
  "Wiping the magnifying glass clean.",
  "Shuffling the pages back into order.",
  "Pinning the receipt to the rest.",
  "Folding down the corner of page seven.",
  "Smiling at the well-organized notes.",
];

const MICROCOPY_INTERVAL_MS = 4000;

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
  processingProgress: { status?: string; isStuck?: boolean } | null;
  /** 0-100 — bytes uploaded so far for the in-flight XHR. */
  uploadProgress: number;
}

/**
 * Simple phase derivation per Andrew S100 v3.
 *
 * "Uploading" phase ends the moment bytes are fully transmitted (uploadProgress
 * = 100), not when the server response arrives. That bridges the classifier
 * gap so users see "Parsing" — not a stuck "Uploading" bar at 100% — while the
 * server runs classification (typically 3-8s for a small SBC).
 */
export function derivePhase(input: DerivePhaseInput): ParseDocPhase {
  const { uploadStatus, processingProgress, uploadProgress } = input;
  if (uploadStatus === "uploading" && uploadProgress < 100) return "uploading";
  if (processingProgress?.status === "processed") return "complete";
  if (processingProgress?.status === "error" || processingProgress?.isStuck) return "error";
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

const HOLD_AFTER_N_MS = 10_000;
const FINALIZING_DURATION_MS = 15_000;
const SYNCING_DURATION_MS = 20_000;

function useSyntheticDisplayedPage(doc: ParseDoc): SyntheticState {
  // React 19 idiomatic: setState-during-render with equality guards for the
  // prop-derived state transitions; setTimeout-callback setState for the timers.
  const [displayedPage, setDisplayedPage] = useState(0);
  const [lastTotalPages, setLastTotalPages] = useState<number | null>(null);
  const [subPhase, setSubPhase] = useState<SubPhase>("ticking");

  // Reset on totalPages change (during render with equality guard). Starts at
  // 0 so the user sees "Page 0 of N" immediately on first render — the tick
  // increments to 1 after the first interval.
  if (doc.totalPages !== lastTotalPages) {
    setLastTotalPages(doc.totalPages);
    setDisplayedPage(0);
    setSubPhase("ticking");
  }

  // Skip-to-complete on backend signal (during render with equality guard).
  // Cancels every in-flight timer naturally — their effects bail out on
  // subPhase change via the cleanup function.
  if (doc.phase === "complete" && subPhase !== "complete") {
    setSubPhase("complete");
    if (doc.totalPages != null && doc.totalPages > 0 && displayedPage < doc.totalPages) {
      setDisplayedPage(doc.totalPages);
    }
  }

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
  // S100 v3 fix: include 1-page docs (was `< 2` — that left 1-page bills
  // stuck at "Page 0 of 1" with no sub-phase progression). Single-page docs
  // tick once (0 → 1), transition to hold, then proceed through finalizing /
  // syncing / final_steps until backend signals complete.
  useEffect(() => {
    if (subPhase !== "ticking") return;
    if (doc.totalPages == null || doc.totalPages < 1) return;
    if (doc.phase === "complete" || doc.phase === "error") return;
    const ceiling = doc.totalPages;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const scheduleNext = () => {
      if (cancelled) return;
      const delay = pickNextTickInterval();
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
  }, [doc.totalPages, doc.phase, subPhase]);

  // Hold → Finalizing transition (10s)
  useEffect(() => {
    if (subPhase !== "hold") return;
    if (doc.phase === "complete" || doc.phase === "error") return;
    const t = setTimeout(() => setSubPhase("finalizing"), HOLD_AFTER_N_MS);
    return () => clearTimeout(t);
  }, [subPhase, doc.phase]);

  // Finalizing → Syncing transition (15s)
  useEffect(() => {
    if (subPhase !== "finalizing") return;
    if (doc.phase === "complete" || doc.phase === "error") return;
    const t = setTimeout(() => setSubPhase("syncing"), FINALIZING_DURATION_MS);
    return () => clearTimeout(t);
  }, [subPhase, doc.phase]);

  // Syncing → Final Steps transition (20s); Final Steps sustains until backend
  // signals complete (handled by the skip-to-complete during-render guard).
  useEffect(() => {
    if (subPhase !== "syncing") return;
    if (doc.phase === "complete" || doc.phase === "error") return;
    const t = setTimeout(() => setSubPhase("final_steps"), SYNCING_DURATION_MS);
    return () => clearTimeout(t);
  }, [subPhase, doc.phase]);

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

function DocCard({ doc, isHero }: { doc: ParseDoc; isHero: boolean }) {
  const { displayedPage, subPhase } = useSyntheticDisplayedPage(doc);

  const isActive = doc.phase === "uploading" || doc.phase === "parsing";
  const ringColor =
    doc.phase === "complete"
      ? "ring-emerald-200"
      : doc.phase === "error"
        ? "ring-rose-200"
        : isActive
          ? "ring-blue-200"
          : "ring-slate-200";

  // Status text: page count during ticking/hold; staged copy from "finalizing"
  // onward. Suppressed during upload phase (totalPages unknown anyway).
  // S100 v3 fallback: when phase=parsing but totalPages isn't yet seeded
  // (rare race — upload response landed but classifier somehow didn't surface
  // pageCount), show "Reading…" so the user always has a visible status
  // signal between the bar and the microcopy.
  const statusText: string | null = (() => {
    if (doc.phase !== "parsing") return null;
    const staged = subPhaseStatusText(subPhase);
    if (staged) return staged;
    if (doc.totalPages != null && doc.totalPages > 0) {
      return `Page ${displayedPage} of ${doc.totalPages}`;
    }
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
    if (doc.phase === "uploading") return Math.max(5, doc.uploadProgress);
    if (doc.phase === "complete") return 100;
    if (doc.phase === "error") return 0;
    if (doc.phase === "queued") return 0;
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
        <PhaseIcon phase={doc.phase} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p className={`font-semibold text-slate-900 truncate ${isHero ? "text-base" : "text-sm"}`}>
              {doc.label}
            </p>
            <PhaseLabel phase={doc.phase} />
          </div>
          <p className="text-xs text-slate-500 truncate mt-0.5">{doc.fileName}</p>
          {doc.phase === "error" && doc.errorMessage && (
            <p className="text-xs text-rose-600 mt-2 leading-relaxed">{doc.errorMessage}</p>
          )}
          {doc.phase !== "complete" && doc.phase !== "error" && (
            <>
              <div className="mt-3 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-700 ${
                    doc.phase === "queued" ? "bg-slate-300" : "bg-blue-500"
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
}: UnifiedParseScreenProps) {
  const [microcopyIdx, setMicrocopyIdx] = useState(0);

  useEffect(() => {
    const allDone = docs.every((d) => d.phase === "complete" || d.phase === "error");
    if (allDone) return;
    const interval = setInterval(() => {
      setMicrocopyIdx((i) => (i + 1) % ROTATING_MICROCOPY.length);
    }, MICROCOPY_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [docs]);

  const allComplete = docs.every((d) => d.phase === "complete");
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
          <DocCard key={doc.id} doc={doc} isHero={isHero} />
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
