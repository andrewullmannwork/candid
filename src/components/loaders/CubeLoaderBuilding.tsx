"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils/cn";

/**
 * CubeLoaderBuilding — page-navigation + initial-load loader.
 *
 * Port of design's #6 rework B (s112-loading-screens/loaders-v2.jsx:444): a
 * floating gradient cube with an animated check completes a check, while a
 * wireframe document below it fills in line by line (500ms per line, 6 lines,
 * loops). Conveys "Candid is reading + building your view" without surfacing
 * any specific progress signal — appropriate for navigation boundaries where
 * we don't know how long the next route will take to mount.
 *
 * Used by /app/(app)/loading.tsx as the Next.js loading boundary for every
 * /(app)/* route, plus consumable by /dashboard initial planResult fetch
 * (replaces the prior 5×5 centered spinner) per S112 §1.C.1 Rec 15.
 *
 * Keyframes (cdCubeFloat / cdCubeGlow / cdCheckDraw) live in app/globals.css.
 */
export function CubeLoaderBuilding({
  className,
  variant = "page",
  size,
  tone = "brand",
}: {
  className?: string;
  /** "inline" (S330): just the cube with its check, sized for a button or a row — no page wireframe, no min-height. */
  variant?: "page" | "inline";
  /** inline only — the cube's edge in px (default 18). */
  size?: number;
  /** inline only — "onDark" draws a white cube with a blue check for use on a primary button. */
  tone?: "brand" | "onDark";
}) {
  const TOTAL_LINES = 6;
  const LINE_WIDTHS = [86, 64, 92, 72, 80, 56];
  const [filled, setFilled] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setFilled((f) => (f + 1) % (TOTAL_LINES + 1));
    }, 500);
    return () => clearInterval(id);
  }, []);

  if (variant === "inline") {
    const s = size ?? 18;
    const dark = tone === "onDark";
    return (
      <span role="status" aria-label="Loading" className={cn("inline-flex items-center justify-center align-middle", className)}>
        <span
          className={cn("relative block", dark ? "bg-white" : "bg-gradient-to-br from-blue-600 to-blue-700")}
          style={{ width: s, height: s, borderRadius: Math.round(s * 0.28), animation: "cdCubeFloat 3.2s ease-in-out infinite" }}
        >
          <svg viewBox="0 0 24 24" className="absolute inset-0 h-full w-full" fill="none" stroke={dark ? "#2563eb" : "white"} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 12.5l3.2 3.2L17 9" style={{ strokeDasharray: 22, animation: "cdCheckDraw 2.0s ease-in-out infinite" }} />
          </svg>
        </span>
      </span>
    );
  }

  return (
    <div
      className={cn(
        "w-full min-h-[60vh] flex items-center justify-center px-6",
        className,
      )}
      role="status"
      aria-label="Loading"
    >
      <div className="flex flex-col items-center gap-7">
        {/* Floating + glowing cube with animated check */}
        <div
          className="relative w-[76px] h-[76px] rounded-[18px] bg-gradient-to-br from-blue-600 to-blue-700"
          style={{
            animation: "cdCubeFloat 3.2s ease-in-out infinite, cdCubeGlow 3.2s ease-in-out infinite",
          }}
        >
          <svg
            viewBox="0 0 24 24"
            className="absolute inset-0 w-full h-full"
            fill="none"
            stroke="white"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path
              d="M7 12.5l3.2 3.2L17 9"
              style={{
                strokeDasharray: 22,
                // S132: started at 2.2s, sped to 0.9s (S131; frantic), then
                // 1.6s (still felt fast on /support Suspense flash). Settled
                // at 2.0s — one full cycle (draw → hold → fade → redraw)
                // reads deliberate. Paired with useMinHoldLoading(2000ms) so
                // in-page mounts always show ≥1 full check before unmount.
                animation: "cdCheckDraw 2.0s ease-in-out infinite",
              }}
            />
          </svg>
        </div>

        {/* Wireframe page filling in line by line */}
        <div className="w-[min(280px,100%)] px-5 py-[18px] rounded-2xl bg-white ring-1 ring-gray-200 shadow-sm flex flex-col gap-2.5">
          {/* Title row (filled at step 1) */}
          <div
            className="h-[9px] w-[110px] max-w-[60%] rounded bg-gray-200 transition-opacity duration-200"
            style={{ opacity: filled >= 1 ? 1 : 0.25 }}
          />
          {/* Body lines */}
          {LINE_WIDTHS.map((w, i) => (
            <div
              key={i}
              className="h-1.5 rounded bg-gray-200 transition-opacity duration-200"
              style={{
                width: `${w}%`,
                opacity: filled >= i + 1 ? 1 : 0.25,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
