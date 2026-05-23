"use client";

import type { ReactNode } from "react";

/**
 * Renders children blurred with an upgrade / coming-soon CTA overlaid.
 * Used by /disputes (subscription gate) and /care (feature flag gate) so
 * the user previews what the page will look like instead of staring at a
 * blank interstitial.
 *
 * When `replaceCta` is provided, the CTA card's contents are swapped with
 * that node (typically the inline subscribe form). The card shell + visual
 * position stay the same, so the upgrade prompt → card-collection swap
 * feels like an in-place transition instead of a floating modal.
 *
 * **Per Phase 2 Subplan B1.2** (plans/phase2_implementation.md): this is
 * the canonical "ComingSoonOverlay" primitive — the Subplan's
 * `<ComingSoonOverlay reason eta?>` slot is satisfied by `<LockedOverlay
 * tone="coming_soon" title=... description=... ctaLabel=... />`. No
 * separate `ComingSoonOverlay` component exists or is needed. Future
 * `/case` + `/care` surfaces consume this same primitive.
 */
export function LockedOverlay({
  title,
  description,
  ctaLabel,
  onCta,
  ctaHref,
  tone = "pro",
  replaceCta,
  children,
}: {
  title: string;
  description: string;
  ctaLabel: string;
  onCta?: () => void;
  ctaHref?: string;
  tone?: "pro" | "coming_soon";
  replaceCta?: ReactNode;
  children: ReactNode;
}) {
  const cardClass =
    tone === "coming_soon"
      ? "from-purple-50 to-indigo-50 border-purple-200"
      : "from-blue-50 to-indigo-50 border-blue-200";
  const buttonClass =
    tone === "coming_soon"
      ? "bg-purple-600 hover:bg-purple-700"
      : "bg-blue-600 hover:bg-blue-700";
  // When replaceCta is rendered the card holds a form; switch to a neutral
  // white background so the gradient doesn't fight the form chrome.
  const activeCardClass = replaceCta
    ? "bg-white border-gray-200"
    : `bg-gradient-to-br ${cardClass} border`;

  return (
    <div className="relative min-h-[60vh]">
      {/* Blurred preview */}
      <div
        aria-hidden
        className="pointer-events-none select-none filter blur-sm opacity-40"
      >
        {children}
      </div>

      {/* CTA card — upgrade prompt OR inline replacement (e.g. subscribe form) */}
      <div className="absolute inset-0 flex items-start justify-center pt-20">
        <div
          className={`max-w-lg w-full mx-4 p-6 rounded-xl shadow-xl ${activeCardClass} ${replaceCta ? "" : "text-center"}`}
        >
          {replaceCta ? (
            replaceCta
          ) : (
            <>
              <div className="text-3xl mb-3">{tone === "coming_soon" ? "✨" : "🔒"}</div>
              <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
              <p className="mt-2 text-sm text-gray-600">{description}</p>
              <div className="mt-4 flex flex-col items-center gap-2">
                {ctaHref ? (
                  <a
                    href={ctaHref}
                    className={`px-6 py-2 text-white rounded-lg transition-colors font-medium text-sm ${buttonClass}`}
                  >
                    {ctaLabel}
                  </a>
                ) : (
                  <button
                    onClick={onCta}
                    className={`px-6 py-2 text-white rounded-lg transition-colors font-medium text-sm ${buttonClass}`}
                  >
                    {ctaLabel}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
