"use client";

/**
 * CodeCarouselLoaderV3 — the "Audit flow" loader.
 *
 * Used wherever the user is in audit context:
 *   - Bill audit running (claim.status='processing' inline above bills list)
 *   - In-claim navigation transitions (/claim ↔ /claim?claim=ID)
 *   - ClaimDetail.tsx data-fetch loading state
 *   - Dispute letter drafting / re-drafting (POST /api/disputes/generate)
 *
 * Port of `plans/findings/design-handoffs/s112-loading-screens/project/loaders-v3.jsx`
 * (lines 249-334 CodeCarouselLoaderV3 + lines 99-126 MessageRotatorV3 + lines
 * 132-189 useDemoSequence/PageCounter). Container-query responsive (cdL- prefix)
 * — scales cleanly 720px desktop → 320px mobile.
 *
 * The CPT-code carousel is decorative — hardcoded 10-code list per design intent
 * (the user reads "stuff scrolling = work being done", not actual audit data).
 *
 * Counter mechanic (production wiring): caller passes external state via
 * (currentLine, totalLines) — the design's internal useDemoSequence loop is
 * replaced by external props since real progress isn't known in MVP. Caller can
 * override the counter row with `subPhaseText` for "Cross-checking against
 * benchmarks…" / "Finalizing…" terminal stages.
 *
 * Message rotator pulls from ROTATING_MICROCOPY (S93 55-line list) at the
 * standard MICROCOPY_INTERVAL_MS (4000ms).
 */

import { useEffect, useState } from "react";
import { ROTATING_MICROCOPY, MICROCOPY_INTERVAL_MS } from "@/lib/microcopy/playful-microcopy";

const CARRIED_CODES: Array<{ code: string; label: string }> = [
  { code: "99214", label: "Office visit, established" },
  { code: "85025", label: "CBC with differential" },
  { code: "90837", label: "Therapy, 60 minutes" },
  { code: "J3490", label: "Unclassified drug" },
  { code: "80053", label: "Comprehensive metabolic panel" },
  { code: "93000", label: "Electrocardiogram, complete" },
  { code: "99070", label: "Supplies and materials" },
  { code: "36415", label: "Routine venipuncture" },
  { code: "70450", label: "CT head without contrast" },
  { code: "99283", label: "Emergency dept visit" },
];

const ROW_HEIGHT_PX = 46;
const VISIBLE_ROWS = 5;
const CAROUSEL_TICK_MS = 900;

export interface CodeCarouselLoaderV3Props {
  /** Heading above the counter. Default: "Auditing your bill". */
  title?: string;
  /** Real audit progress; 0 until backend signal. */
  currentLine?: number;
  /** Total lines from claim; null pre-classify (counter shows "Line 0 of …"). */
  totalLines?: number | null;
  /** Override counter text — e.g. "Cross-checking against benchmarks…", "Finalizing…". */
  subPhaseText?: string | null;
  /** Rotating brand-voice messages. Defaults to ROTATING_MICROCOPY. */
  messages?: string[];
  /** Rotation interval (ms). Default MICROCOPY_INTERVAL_MS (4000). */
  messageIntervalMs?: number;
  /** Optional footer slot (e.g. cancel CTA). */
  footer?: React.ReactNode;
  /** Optional cancel button (X in top-right). */
  onCancel?: () => void;
}

export function CodeCarouselLoaderV3({
  title = "Auditing your bill",
  currentLine = 0,
  totalLines = null,
  subPhaseText,
  messages = ROTATING_MICROCOPY,
  messageIntervalMs = MICROCOPY_INTERVAL_MS,
  footer,
  onCancel,
}: CodeCarouselLoaderV3Props) {
  const [carouselTick, setCarouselTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setCarouselTick((v) => v + 1), CAROUSEL_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Triplicate the list so the scroll never visually "ends".
  const list = [...CARRIED_CODES, ...CARRIED_CODES, ...CARRIED_CODES];
  const offset = (carouselTick % CARRIED_CODES.length) * ROW_HEIGHT_PX;

  // Counter resolution: subPhaseText wins; otherwise "Line X of N".
  const counter =
    subPhaseText && subPhaseText.length > 0
      ? subPhaseText
      : totalLines != null
        ? `Line ${Math.max(0, Math.min(currentLine, totalLines))} of ${totalLines}`
        : "Reading…";

  return (
    <div
      className="cdL-root relative flex w-full flex-col bg-white"
      style={{ containerType: "inline-size", containerName: "cdL" }}
      role="status"
      aria-label={subPhaseText ?? title}
    >
      {onCancel && (
        <button
          onClick={onCancel}
          className="absolute right-3 top-3 z-10 inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
          aria-label="Cancel"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 6l12 12M6 18L18 6" />
          </svg>
        </button>
      )}

      <div className="cdL-shell flex flex-1 flex-col items-center justify-center gap-10 px-10 py-9">
        {/* CPT code carousel */}
        <div
          className="cdL-carousel relative overflow-hidden"
          style={{ width: "min(400px, 100%)", height: ROW_HEIGHT_PX * VISIBLE_ROWS }}
        >
          {/* Highlighted center band */}
          <div
            className="cdL-carousel-band absolute inset-x-0 z-0 border-y border-blue-200 bg-blue-50"
            style={{ top: ROW_HEIGHT_PX * 2, height: ROW_HEIGHT_PX, pointerEvents: "none" }}
          />
          {/* Fade overlay (top + bottom edges) */}
          <div
            className="absolute inset-0 z-20"
            style={{
              background:
                "linear-gradient(180deg, white 0%, transparent 28%, transparent 72%, white 100%)",
              pointerEvents: "none",
            }}
          />
          {/* Scrolling row stack */}
          <div
            className="absolute inset-x-0 top-0 z-10"
            style={{
              transform: `translateY(-${offset}px)`,
              transition: "transform .58s cubic-bezier(.65,.05,.36,1)",
            }}
          >
            {list.map((row, idx) => {
              const centerIdx = (carouselTick % CARRIED_CODES.length) + 2;
              const isCenter = idx === centerIdx;
              return (
                <div
                  key={idx}
                  className="cdL-carousel-row flex items-center gap-4 px-5"
                  style={{ height: ROW_HEIGHT_PX }}
                >
                  <span
                    className={`cdL-code shrink-0 whitespace-nowrap font-semibold transition-colors ${
                      isCenter ? "text-blue-700" : "text-slate-500"
                    }`}
                    style={{
                      fontFamily: "Geist Mono, ui-monospace, monospace",
                      fontSize: 16,
                      minWidth: 64,
                    }}
                  >
                    {row.code}
                  </span>
                  <span
                    className={`cdL-label flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-sm transition-colors ${
                      isCenter ? "text-slate-900" : "text-slate-400"
                    }`}
                  >
                    {row.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Title + counter + messages + hairline progress */}
        <div className="flex flex-col items-center">
          <div className="cdL-title text-[18px] font-semibold tracking-tight text-slate-900 mb-1.5">
            {title}
          </div>

          <div
            className="cdL-counter-row mb-4 flex h-5 items-center justify-center text-[13.5px] text-slate-500"
            style={{ letterSpacing: "-0.005em" }}
          >
            <span
              className="whitespace-nowrap"
              style={{
                fontFamily: "Geist Mono, ui-monospace, monospace",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {counter}
            </span>
          </div>

          <div
            className="cdL-rotator-wrap mb-4 flex items-center justify-center"
            style={{ maxWidth: 380, minHeight: 42 }}
          >
            <MessageRotator messages={messages} intervalMs={messageIntervalMs} />
          </div>

          <div className="cdL-hairline-wrap" style={{ width: 240 }}>
            <HairlineProgress />
          </div>
        </div>

        {footer && <div className="w-full max-w-md">{footer}</div>}
      </div>
    </div>
  );
}

function MessageRotator({ messages, intervalMs }: { messages: string[]; intervalMs: number }) {
  const [i, setI] = useState(0);
  const [shown, setShown] = useState(true);
  useEffect(() => {
    if (messages.length === 0) return;
    const id = setInterval(() => {
      setShown(false);
      setTimeout(() => {
        setI((v) => (v + 1) % messages.length);
        setShown(true);
      }, 200);
    }, intervalMs);
    return () => clearInterval(id);
  }, [messages, intervalMs]);
  return (
    <div
      className="cdL-rotator-text text-center text-[14px] leading-relaxed text-slate-500"
      style={{
        textWrap: "balance",
        opacity: shown ? 1 : 0,
        transform: shown ? "translateY(0)" : "translateY(4px)",
        transition: "opacity .2s ease-out, transform .2s ease-out",
      }}
    >
      {messages[i] ?? ""}
    </div>
  );
}

function HairlineProgress() {
  return (
    <div
      className="relative overflow-hidden rounded-full"
      style={{ width: "100%", height: 3, background: "rgb(226 232 240)" }}
    >
      <div
        className="absolute inset-y-0 rounded-full"
        style={{
          width: "50%",
          background:
            "linear-gradient(90deg, transparent, rgb(37 99 235) 30%, rgb(37 99 235) 70%, transparent)",
          animation: "cdLoadBar 1.8s cubic-bezier(.55,.05,.45,1) infinite",
        }}
      />
    </div>
  );
}
