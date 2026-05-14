"use client";

/**
 * S70 — Shared parsing-progress UI used by /upload (single-doc) and /compare
 * (multi-doc).
 *
 * Per Q-S70-2 LOCK + user direction: the long parse latency (15-90s typical)
 * needs to feel intentional, not broken. Three design moves:
 *
 *   1. Per-doc state cards — explicit ordering ("Plan A → Plan B → Plan C"),
 *      explicit phase ("Uploading", "Parsing", "Cross-referencing", "Done"),
 *      and per-card progress bar. No mystery.
 *
 *   2. Rotating microcopy — every 4s a new "what we're doing right now" line
 *      cycles in. Educates the user about value while they wait. Pull from a
 *      curated list (no marketing fluff).
 *
 *   3. Animated state pulse — Tailwind animate-pulse on the active card +
 *      smooth color transitions on phase changes. Subtle, not gimmicky.
 *
 * Component is purely presentational — caller owns the upload + polling
 * logic and feeds in `docs` array. When all docs reach `complete` (or the
 * caller wants to advance), caller renders next view.
 */

import { useEffect, useState } from "react";

export type ParseDocPhase =
  | "queued"
  | "uploading"
  | "parsing"
  | "cross_referencing"
  | "complete"
  | "error";

export interface ParseDoc {
  /** Stable client-side ID used as React key. */
  id: string;
  /** User-visible label ("Plan A", "Your SBC", etc.). */
  label: string;
  /** File name surfaced under the label for orientation. */
  fileName: string;
  phase: ParseDocPhase;
  /** Progress 0-100 within the current phase. */
  progress: number;
  /** Optional sub-step text ("Pages 4/8 extracted", "Matching to canonical…"). */
  detail?: string;
  /** Error message if phase === "error". */
  errorMessage?: string;
}

interface PlayfulParsingScreenProps {
  /** 1-3 docs being processed. Order is presentation order. */
  docs: ParseDoc[];
  /** Banner copy above the doc cards. */
  title?: string;
  /** Subtitle copy under the title. */
  subtitle?: string;
  /** Optional secondary "why" line rendered under the subtitle (explains the wait). */
  whySubtitle?: string;
  /** Action footer rendered when all docs are complete. */
  footer?: React.ReactNode;
  /**
   * Optional cancel handler. When provided, renders an X button in the top-left
   * corner of the screen. Caller decides whether the cancel actually aborts an
   * in-flight upload, just clears local state, or both (during isUploading we
   * abort the XHR; during processing we clear UI but backend continues).
   */
  onCancel?: () => void;
}

// Whimsical doctor's-office vignettes — playful, never reveal mechanics.
// Goal: keep the wait feel intentional + light, not "here's what we're doing
// under the hood." Add new lines anywhere; keep them concrete + visual.
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
];

const MICROCOPY_INTERVAL_MS = 4000;

function PhaseLabel({ phase }: { phase: ParseDocPhase }) {
  const labels: Record<ParseDocPhase, string> = {
    queued: "Queued",
    uploading: "Uploading",
    parsing: "Reading the document",
    cross_referencing: "Cross-referencing",
    complete: "Ready",
    error: "Couldn't process",
  };
  const colors: Record<ParseDocPhase, string> = {
    queued: "text-slate-500",
    uploading: "text-blue-600",
    parsing: "text-blue-600",
    cross_referencing: "text-indigo-600",
    complete: "text-emerald-600",
    error: "text-rose-600",
  };
  return (
    <span className={`text-xs font-semibold ${colors[phase]}`}>
      {labels[phase]}
    </span>
  );
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
  // uploading / parsing / cross_referencing — animated.
  return (
    <div className="w-9 h-9 rounded-full bg-blue-100 flex items-center justify-center">
      <svg
        className="w-5 h-5 text-blue-600 animate-spin"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" d="M12 3a9 9 0 019 9" />
      </svg>
    </div>
  );
}

function DocCard({ doc }: { doc: ParseDoc }) {
  const isActive =
    doc.phase === "uploading" ||
    doc.phase === "parsing" ||
    doc.phase === "cross_referencing";
  const ringColor =
    doc.phase === "complete"
      ? "ring-emerald-200"
      : doc.phase === "error"
        ? "ring-rose-200"
        : isActive
          ? "ring-blue-200"
          : "ring-slate-200";

  const progress = Math.max(0, Math.min(100, doc.progress));

  return (
    <div
      className={`p-4 rounded-2xl bg-white ring-1 ${ringColor} transition-all ${
        isActive ? "shadow-sm" : ""
      }`}
    >
      <div className="flex items-start gap-3">
        <PhaseIcon phase={doc.phase} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-slate-900 truncate">{doc.label}</p>
            <PhaseLabel phase={doc.phase} />
          </div>
          <p className="text-xs text-slate-500 truncate mt-0.5">{doc.fileName}</p>
          {doc.detail && (
            <p className="text-xs text-slate-600 mt-2 leading-relaxed">{doc.detail}</p>
          )}
          {doc.phase === "error" && doc.errorMessage && (
            <p className="text-xs text-rose-600 mt-2 leading-relaxed">{doc.errorMessage}</p>
          )}
          {doc.phase !== "complete" && doc.phase !== "error" && (
            <div className="mt-3 h-1.5 rounded-full bg-slate-100 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-700 ${
                  doc.phase === "queued" ? "bg-slate-300" : "bg-blue-500"
                }`}
                style={{ width: `${doc.phase === "queued" ? 0 : progress || 8}%` }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function PlayfulParsingScreen({
  docs,
  title = "Reading your plan documents",
  subtitle = "We're extracting every detail.",
  whySubtitle,
  footer,
  onCancel,
}: PlayfulParsingScreenProps) {
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

  return (
    <div className="max-w-2xl mx-auto py-10 px-4 relative">
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel upload"
          className="absolute top-2 left-2 w-9 h-9 flex items-center justify-center rounded-full hover:bg-slate-100 transition-colors text-slate-400 hover:text-slate-700"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
          >
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
        <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
        <p className="text-sm text-slate-600 mt-2 max-w-md mx-auto">{subtitle}</p>
        {whySubtitle && (
          <p className="text-xs text-slate-500 mt-3 max-w-md mx-auto leading-relaxed">
            {whySubtitle}
          </p>
        )}
      </div>

      <div className="space-y-3">
        {docs.map((doc) => (
          <DocCard key={doc.id} doc={doc} />
        ))}
      </div>

      {!allComplete && !anyError && (
        <div className="mt-8 text-center min-h-[2.5rem]">
          <p
            key={microcopyIdx}
            className="text-sm text-slate-600 animate-fade-in inline-block"
          >
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
