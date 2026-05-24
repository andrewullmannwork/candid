"use client";

/**
 * StackLoaderV3 — primary parse-progress loader (S119 → B2-UP.1 port).
 *
 * Ported from the s112-loading-screens design bundle (loaders-v3.jsx) with
 * production wiring per D-§1.B.1-B (S114 Phase 1 UI Integration Subplan):
 *   - currentPage / totalPages / subPhaseText / messages / title accepted as
 *     props (the design used an internal useDemoSequence loop; production uses
 *     external state from upload/page.tsx polling)
 *   - 5-doc decorative card stack animates internally on a fixed ~900ms tick
 *     (visual fidget; not tied to real progress)
 *   - Page counter row reflects real (currentPage, totalPages) — switches to
 *     `subPhaseText` when caller surfaces "Syncing to profile…" / "Finalizing…"
 *   - Message rotator cycles every `messageIntervalMs` (default 2400ms) — the
 *     S98 random-paced 3-5-7-10s tick lives at the page-counter layer above
 *
 * Container-query responsive (cdL- prefix) preserved from design — scales
 * cleanly from 720px desktop down to 320px mobile.
 *
 * Used at /upload priority 10 (active parsing). /compare passes through
 * UnifiedParseScreen unchanged.
 */
import { useEffect, useState } from "react";

const DEFAULT_MESSAGES = [
  "Reading your document…",
  "We read every page twice — once for what's there, once for what isn't.",
  "Surfacing covered benefits…",
  "Decoding insurance-speak…",
  "Worth the extra minute. Promise.",
];

const DOC_STACK_TOTAL = 5;
const DOC_TICK_MS = 900;

export interface StackLoaderV3Props {
  /** Real page progress; 0 until classifier known. */
  currentPage: number;
  /** Total page count from classifier; null pre-classify (shows counter as "Page 0 of …"). */
  totalPages: number | null;
  /**
   * Override the counter text when set (e.g. "Syncing to profile…",
   * "Finalizing…"). Used by the parent state machine after the page sweep
   * completes.
   */
  subPhaseText?: string | null;
  /** Heading above the counter. Default: "Reading your document". */
  title?: string;
  /** Rotating brand-voice messages under the counter. */
  messages?: string[];
  /** Rotation interval for the message rotator (ms). Default 2400. */
  messageIntervalMs?: number;
  /** Optional footer slot (e.g. large-doc "browse Candid" CTA from S78). */
  footer?: React.ReactNode;
  /** Optional cancel button (S91 X-out). */
  onCancel?: () => void;
}

export function StackLoaderV3({
  currentPage,
  totalPages,
  subPhaseText,
  title = "Reading your document",
  messages = DEFAULT_MESSAGES,
  messageIntervalMs = 2400,
  footer,
  onCancel,
}: StackLoaderV3Props) {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setActive((a) => (a + 1) % (DOC_STACK_TOTAL + 1)), DOC_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Counter resolution: subPhaseText wins; otherwise show "Page X of N".
  const counter =
    subPhaseText && subPhaseText.length > 0
      ? subPhaseText
      : totalPages != null
        ? `Page ${Math.max(0, Math.min(currentPage, totalPages))} of ${totalPages}`
        : "Reading…";

  return (
    <div
      className="cdL-root relative flex w-full flex-col bg-white"
      style={{ containerType: "inline-size", containerName: "cdL" }}
    >
      {onCancel && (
        <button
          onClick={onCancel}
          className="absolute right-3 top-3 z-10 inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
          aria-label="Cancel upload"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 6l12 12M6 18L18 6" />
          </svg>
        </button>
      )}

      <div className="cdL-shell flex flex-1 flex-col items-center justify-center gap-10 px-10 py-9">
        <div className="cdL-doc-stack flex items-end gap-3.5">
          {Array.from({ length: DOC_STACK_TOTAL }).map((_, i) => {
            const isDone = i < active;
            const isScanning = i === active && active < DOC_STACK_TOTAL;
            return (
              <div
                key={i}
                className="cdL-doc-card relative overflow-hidden box-border rounded-xl px-2.5 py-3 transition-all duration-300"
                style={{
                  width: 78,
                  height: 104,
                  background: isDone ? "var(--verified-soft)" : "white",
                  border: `1px solid ${isDone ? "var(--verified-ring)" : "rgb(226 232 240)"}`,
                  boxShadow: isScanning
                    ? "0 4px 12px rgba(15, 23, 42, 0.10)"
                    : "0 1px 2px rgba(15, 23, 42, 0.04)",
                  transform: isScanning ? "translateY(-10px)" : "translateY(0)",
                }}
              >
                <div
                  className="mb-2 rounded"
                  style={{
                    height: 4,
                    width: "55%",
                    background: isDone ? "var(--verified-ring)" : "rgb(226 232 240)",
                  }}
                />
                {[90, 78, 85, 72, 88].map((w, ii) => (
                  <div
                    key={ii}
                    className="rounded"
                    style={{
                      height: 3,
                      width: `${w}%`,
                      background: "rgb(226 232 240)",
                      marginBottom: 5,
                    }}
                  />
                ))}
                {isScanning && (
                  <div
                    className="absolute inset-x-0 h-0.5"
                    style={{
                      background: "rgb(37 99 235)",
                      boxShadow: "0 0 14px hsla(217,91%,60%,0.7)",
                      animation: "cdScanDoc 0.85s linear",
                    }}
                  />
                )}
                {isDone && (
                  <div
                    className="cdL-doc-check absolute flex items-center justify-center rounded-full"
                    style={{
                      bottom: 7,
                      right: 7,
                      width: 22,
                      height: 22,
                      background: "var(--verified-bg)",
                      animation: "cdPop 0.32s ease-out",
                    }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex flex-col items-center">
          <div className="cdL-title text-[18px] font-semibold tracking-tight text-slate-900 mb-1.5">
            {title}
          </div>

          <div className="cdL-counter-row mb-4 flex h-5 items-center justify-center text-[13.5px] text-slate-500" style={{ letterSpacing: "-0.005em" }}>
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

          <div className="cdL-rotator-wrap mb-4 flex items-center justify-center" style={{ maxWidth: 380, minHeight: 42 }}>
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
    <div className="relative overflow-hidden rounded-full" style={{ width: "100%", height: 3, background: "rgb(226 232 240)" }}>
      <div
        className="absolute inset-y-0 rounded-full"
        style={{
          width: "50%",
          background: "linear-gradient(90deg, transparent, rgb(37 99 235) 30%, rgb(37 99 235) 70%, transparent)",
          animation: "cdLoadBar 1.8s cubic-bezier(.55,.05,.45,1) infinite",
        }}
      />
    </div>
  );
}
