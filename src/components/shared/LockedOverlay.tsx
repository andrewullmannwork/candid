"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";

type Tone = "pro" | "coming_soon" | "care" | "case" | "hsa";

const TONE_STYLES: Record<Tone, {
  card: string;
  button: string;
  pill: string;
  iconBg: string;
}> = {
  pro: {
    card: "from-blue-50 to-indigo-50 border-blue-200",
    button: "bg-blue-600 hover:bg-blue-700",
    pill: "bg-blue-100 text-blue-700 border border-blue-200",
    iconBg: "bg-blue-50 text-blue-600 border border-blue-100",
  },
  coming_soon: {
    card: "from-purple-50 to-indigo-50 border-purple-200",
    button: "bg-purple-600 hover:bg-purple-700",
    pill: "bg-purple-100 text-purple-700 border border-purple-200",
    iconBg: "bg-purple-50 text-purple-600 border border-purple-100",
  },
  care: {
    card: "from-teal-50 to-cyan-50 border-teal-200",
    button: "bg-teal-600 hover:bg-teal-700",
    pill: "bg-teal-100 text-teal-700 border border-teal-200",
    iconBg: "bg-teal-50 text-teal-600 border border-teal-100",
  },
  case: {
    card: "from-purple-50 to-indigo-50 border-purple-200",
    button: "bg-purple-600 hover:bg-purple-700",
    pill: "bg-purple-100 text-purple-700 border border-purple-200",
    iconBg: "bg-purple-50 text-purple-600 border border-purple-100",
  },
  hsa: {
    card: "from-rose-50 to-pink-50 border-rose-100",
    button: "bg-rose-400 hover:bg-rose-500",
    pill: "bg-rose-50 text-rose-500 border border-rose-100",
    iconBg: "bg-rose-50 text-rose-500 border border-rose-100",
  },
};

/**
 * Renders children blurred with an upgrade / coming-soon CTA overlaid.
 * Used by /disputes (subscription gate), /care + /case + /hsa-marketplace
 * (alpha coming-soon stubs), so the user previews what the page will look
 * like instead of staring at a blank interstitial.
 *
 * When `replaceCta` is provided, the CTA card's contents are swapped with
 * that node (typically the inline subscribe form). The card shell + visual
 * position stay the same, so the upgrade prompt → card-collection swap
 * feels like an in-place transition instead of a floating modal.
 *
 * **Per Phase 2 Subplan B1.2** (plans/phase2_implementation.md): this is
 * the canonical "ComingSoonOverlay" primitive — the Subplan's
 * `<ComingSoonOverlay reason eta?>` slot is satisfied by `<LockedOverlay
 * tone="case|care|hsa" title=... description=... bullets=... />`. No
 * separate `ComingSoonOverlay` component exists or is needed.
 *
 * B-LAND.1 extended props (all optional, fully backwards-compatible):
 * - `icon` — overrides default emoji
 * - `bullets` — feature highlights between description + CTAs
 * - `pillLabel` — "Coming Soon" badge above title
 * - `secondaryCtaLabel/Href/onSecondaryCta` — second outline button
 * - `fineprint` — small footer text (legal disclaimer)
 * - `extraSlot` — custom content between CTAs + fineprint (e.g. HSA partner form)
 * - `closable` — renders X button (top-right of card); navigates back via
 *   `router.back()` if same-origin referrer else falls back to `/dashboard`.
 * - `closeHref` — when set, the X button navigates to this explicit route
 *   instead of the `router.back()`/`/dashboard` default (e.g. HSA → `/plan`).
 */
export function LockedOverlay({
  title,
  description,
  ctaLabel,
  onCta,
  ctaHref,
  tone = "pro",
  replaceCta,
  icon,
  bullets,
  pillLabel,
  secondaryCtaLabel,
  secondaryCtaHref,
  onSecondaryCta,
  fineprint,
  extraSlot,
  closable,
  closeHref,
  children,
}: {
  title: string;
  description: string;
  ctaLabel: string;
  onCta?: () => void;
  ctaHref?: string;
  tone?: Tone;
  replaceCta?: ReactNode;
  icon?: ReactNode;
  bullets?: string[];
  pillLabel?: string;
  secondaryCtaLabel?: string;
  secondaryCtaHref?: string;
  onSecondaryCta?: () => void;
  fineprint?: string;
  extraSlot?: ReactNode;
  closable?: boolean;
  closeHref?: string;
  children: ReactNode;
}) {
  const styles = TONE_STYLES[tone];
  const router = useRouter();

  function handleClose() {
    if (closeHref) {
      router.push(closeHref);
      return;
    }
    const referrer = typeof document !== "undefined" ? document.referrer : "";
    if (referrer) {
      try {
        const sameOrigin = new URL(referrer).origin === window.location.origin;
        if (sameOrigin) {
          router.back();
          return;
        }
      } catch {
        // Malformed referrer — fall through to dashboard
      }
    }
    router.push("/dashboard");
  }
  // When replaceCta is rendered the card holds a form; switch to a neutral
  // white background so the gradient doesn't fight the form chrome.
  const activeCardClass = replaceCta
    ? "bg-white border border-gray-200"
    : `bg-gradient-to-br ${styles.card} border`;

  // Pill defaults to "Coming Soon" for non-pro tones unless explicitly set
  const resolvedPill = pillLabel ?? (tone !== "pro" ? "Coming Soon" : undefined);

  return (
    <div className="relative min-h-[60vh]">
      {/* Blurred preview */}
      <div
        aria-hidden
        className="pointer-events-none select-none filter blur-[2px] opacity-40"
      >
        {children}
      </div>

      {/* CTA card — upgrade prompt OR inline replacement (e.g. subscribe form) */}
      <div className="absolute inset-0 flex items-start justify-center pt-12 sm:pt-16 px-4">
        <div
          className={`relative max-w-lg w-full p-7 sm:p-8 rounded-2xl shadow-xl ${activeCardClass} ${replaceCta ? "" : "text-center"}`}
        >
          {closable && !replaceCta && (
            <button
              type="button"
              onClick={handleClose}
              aria-label="Close"
              className="absolute top-3 right-3 w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-white/60 transition-colors"
            >
              <svg width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <path d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
          {replaceCta ? (
            replaceCta
          ) : (
            <>
              {icon ? (
                <div className={`w-12 h-12 mx-auto rounded-xl flex items-center justify-center mb-4 ${styles.iconBg}`}>
                  {icon}
                </div>
              ) : (
                <div className="text-3xl mb-3">{tone !== "pro" ? "✨" : "🔒"}</div>
              )}

              <h2 className="text-xl font-bold text-gray-900">{title}</h2>

              {resolvedPill && (
                <div className={`inline-flex mt-2 px-2.5 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wide ${styles.pill}`}>
                  {resolvedPill}
                </div>
              )}

              <p className="mt-3 text-sm text-gray-600 leading-relaxed">{description}</p>

              {bullets && bullets.length > 0 && (
                <ul className="mt-5 space-y-2 text-left">
                  {bullets.map((b, i) => (
                    <li key={i} className="flex items-start gap-2.5 text-[13px] text-gray-700">
                      <span className={`shrink-0 w-4 h-4 mt-0.5 rounded-full flex items-center justify-center ${styles.iconBg}`}>
                        <svg width={9} height={9} fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                          <path d="M5 13l4 4L19 7" />
                        </svg>
                      </span>
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-5 flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-2">
                {ctaHref ? (
                  <a
                    href={ctaHref}
                    className={`px-5 py-2 text-white rounded-xl transition-colors font-semibold text-sm ${styles.button}`}
                  >
                    {ctaLabel}
                  </a>
                ) : (
                  <button
                    onClick={onCta}
                    className={`px-5 py-2 text-white rounded-xl transition-colors font-semibold text-sm ${styles.button}`}
                  >
                    {ctaLabel}
                  </button>
                )}
                {secondaryCtaLabel && (secondaryCtaHref ? (
                  <a
                    href={secondaryCtaHref}
                    className="px-5 py-2 text-gray-700 border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors font-medium text-sm"
                  >
                    {secondaryCtaLabel}
                  </a>
                ) : (
                  <button
                    onClick={onSecondaryCta}
                    className="px-5 py-2 text-gray-700 border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors font-medium text-sm"
                  >
                    {secondaryCtaLabel}
                  </button>
                ))}
              </div>

              {extraSlot && (
                <div className="mt-5 pt-5 border-t border-gray-100 text-left">
                  {extraSlot}
                </div>
              )}

              {fineprint && (
                <p className="mt-5 text-[11px] text-gray-400 leading-relaxed">
                  {fineprint}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
