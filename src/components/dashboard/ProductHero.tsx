"use client";

import Link from "next/link";
import { type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

/**
 * ProductHero — equal-width card surfaced in the /dashboard `dash-trio`.
 *
 * One of three above-the-fold heroes (Compare / Claim / Plan). Replaces the
 * S70 full-width Compare gradient hero with peer-of-3 placement per
 * D-§1.C.1-C; design framing is canonical.
 *
 * Visual treatment per S112 §1.C.1 styles.css .ph-card:
 *  - 244px min-height
 *  - 20px border-radius
 *  - Variant-specific gradient backgrounds + tinted borders
 *  - Lift on hover (translateY(-2px) + ring shift)
 *  - status badge (New / Live / Soon — 3-tier product-status vocabulary per
 *    D-§1.C.1-K, distinct from data-verification 5-tier per D-S112-D)
 *  - metric slot accepts any ReactNode (RingMini, dollar span, ComparePlansVisual,
 *    upload-icon for empty-state per D-§1.C.1-L)
 *  - highlight prop adds extra spotlight ring (Claim card on /dashboard by default)
 */

type Variant = "compare" | "claim" | "benefits";
type StatusKind = "new" | "live" | "soon";

interface ProductHeroProps {
  variant: Variant;
  status: { kind: StatusKind; label: string };
  name: string;
  headline: string;
  metric: ReactNode;
  body: ReactNode;
  cta: string;
  href: string;
  highlight?: boolean;
}

const VARIANT_STYLES: Record<
  Variant,
  {
    surface: string;
    name: string;
    metric: string;
    cta: string;
  }
> = {
  compare: {
    surface:
      "bg-gradient-to-br from-white via-violet-50 to-violet-100 border-violet-200 hover:border-violet-300",
    name: "text-blue-700",
    metric: "text-violet-800",
    cta: "text-violet-700",
  },
  claim: {
    surface:
      "bg-gradient-to-br from-white via-blue-50 to-blue-100 border-blue-200 hover:border-blue-400",
    name: "text-blue-700",
    metric: "text-gray-900",
    cta: "text-blue-700",
  },
  benefits: {
    surface:
      "bg-gradient-to-br from-white via-cyan-50 to-cyan-100 border-cyan-200 hover:border-cyan-300",
    name: "text-cyan-800",
    metric: "text-cyan-800",
    cta: "text-cyan-800",
  },
};

const STATUS_STYLES: Record<StatusKind, string> = {
  live: "bg-green-50 text-green-700 ring-1 ring-inset ring-green-300",
  new: "bg-violet-100 text-violet-700 ring-1 ring-inset ring-violet-300",
  soon: "bg-gray-100 text-gray-600 ring-1 ring-inset ring-gray-200",
};

export function ProductHero({
  variant,
  status,
  name,
  headline,
  metric,
  body,
  cta,
  href,
  highlight,
}: ProductHeroProps) {
  const v = VARIANT_STYLES[variant];

  return (
    <Link
      href={href}
      className={cn(
        "group relative overflow-hidden flex flex-col text-left rounded-[20px] p-6 pt-6 min-h-[244px]",
        "border transition-all duration-150 hover:-translate-y-0.5 hover:shadow-[0_12px_32px_-14px_rgba(15,23,42,0.18)]",
        v.surface,
        highlight && "ring-2 ring-offset-1 ring-blue-200/80 shadow-md",
      )}
    >
      {/* Top row — eyebrow name + status badge */}
      <div className="flex justify-between items-center mb-6">
        <div className={cn("text-[12px] font-bold uppercase tracking-[0.12em] whitespace-nowrap", v.name)}>
          {name}
        </div>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 text-[9.5px] font-bold uppercase tracking-[0.08em] px-2 py-0.5 rounded-full whitespace-nowrap",
            STATUS_STYLES[status.kind],
          )}
        >
          {status.kind === "live" && (
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse-dot" />
          )}
          {status.label}
        </span>
      </div>

      {/* Metric slot */}
      <div
        className={cn(
          "text-[38px] font-bold leading-none tracking-[-0.03em] tabular-nums mb-3 flex items-end gap-2",
          v.metric,
        )}
      >
        {metric}
      </div>

      {/* Headline + body */}
      <div className="text-[15px] font-bold text-gray-900 mb-2 tracking-[-0.005em]">{headline}</div>
      <div className="text-[12.5px] leading-[1.55] text-gray-500 flex-1">{body}</div>

      {/* CTA */}
      <div
        className={cn(
          "mt-4 inline-flex items-center gap-1 text-[13px] font-semibold transition-all group-hover:gap-1.5",
          v.cta,
        )}
      >
        {cta}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 5l7 7-7 7" />
        </svg>
      </div>
    </Link>
  );
}
