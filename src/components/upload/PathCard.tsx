"use client";

/**
 * PathCard — "Paths grid" card under the drop zone (B2-UP.1 port).
 *
 * 4-card story below the drop zone: "ONE UPLOAD · EVERY SERVICE SHARPER".
 * Renders disabled (no-link) variant when destination is null (Care path
 * pre-launch per D-§1.B.1-C feature-flag gate).
 *
 * `kind` chip drives the "FROM BILLS" / "FROM PLANS" eyebrow that signals
 * which doc type powers which downstream service.
 */
import type { ReactNode } from "react";

export interface PathCardProps {
  tone: "peach" | "mint" | "lavender" | "sky";
  icon: ReactNode;
  kind: "bill" | "plan";
  title: string;
  body: string;
  /** When null, renders disabled (CTA shown but unclickable). */
  destination: (() => void) | null;
  destLabel: string;
  /** Disabled + render "Notify me" lead-gen capture inline (Care pre-launch). */
  notifyMeCta?: ReactNode;
}

const TONE_STYLES: Record<
  PathCardProps["tone"],
  { bg: string; ring: string; iconBg: string; iconInk: string; eyebrow: string; cta: string }
> = {
  peach: {
    bg: "bg-orange-50/60",
    ring: "ring-orange-100",
    iconBg: "bg-orange-100",
    iconInk: "text-orange-700",
    eyebrow: "text-orange-700",
    cta: "text-orange-700",
  },
  mint: {
    bg: "bg-emerald-50/60",
    ring: "ring-emerald-100",
    iconBg: "bg-emerald-100",
    iconInk: "text-emerald-700",
    eyebrow: "text-emerald-700",
    cta: "text-emerald-700",
  },
  lavender: {
    bg: "bg-violet-50/60",
    ring: "ring-violet-100",
    iconBg: "bg-violet-100",
    iconInk: "text-violet-700",
    eyebrow: "text-violet-700",
    cta: "text-violet-700",
  },
  sky: {
    bg: "bg-sky-50/60",
    ring: "ring-sky-100",
    iconBg: "bg-sky-100",
    iconInk: "text-sky-700",
    eyebrow: "text-sky-700",
    cta: "text-sky-700",
  },
};

export function PathCard({ tone, icon, kind, title, body, destination, destLabel, notifyMeCta }: PathCardProps) {
  const t = TONE_STYLES[tone];
  const disabled = !destination;
  // CTA pinned bottom-left via `mt-auto` so all 4 cards align the CTA row
  // regardless of body length variance.
  const Inner = (
    <>
      <div className={`flex h-9 w-9 items-center justify-center rounded-xl ${t.iconBg} ${t.iconInk}`}>{icon}</div>
      <div className={`mt-3 text-[10px] font-semibold uppercase tracking-widest ${t.eyebrow}`}>
        FROM {kind === "bill" ? "BILLS" : "PLANS"}
      </div>
      <div className="mt-1.5 text-sm font-semibold leading-snug text-slate-900">{title}</div>
      <p className="mt-1.5 text-xs leading-relaxed text-slate-600">{body}</p>
      {notifyMeCta && <div className="mt-auto pt-3">{notifyMeCta}</div>}
      {!notifyMeCta && (
        <div className={`mt-auto pt-3 text-xs font-semibold ${disabled ? "text-slate-400" : t.cta}`}>
          {destLabel}
          {!disabled && " →"}
        </div>
      )}
    </>
  );

  if (disabled) {
    return (
      <div className={`flex h-full flex-col items-start rounded-2xl ${t.bg} p-4 ring-1 ${t.ring} opacity-75`}>{Inner}</div>
    );
  }
  return (
    <button
      type="button"
      onClick={destination}
      className={`flex h-full flex-col items-start rounded-2xl ${t.bg} p-4 text-left ring-1 ${t.ring} transition-all hover:-translate-y-0.5 hover:shadow-md`}
    >
      {Inner}
    </button>
  );
}
