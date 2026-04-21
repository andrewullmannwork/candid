"use client";

import type { ReactNode } from "react";

/**
 * Renders children blurred with an upgrade / coming-soon CTA overlaid.
 * Used by /disputes (subscription gate) and /care (feature flag gate) so
 * the user previews what the page will look like instead of staring at a
 * blank interstitial.
 */
export function LockedOverlay({
  title,
  description,
  ctaLabel,
  onCta,
  ctaHref,
  tone = "pro",
  children,
}: {
  title: string;
  description: string;
  ctaLabel: string;
  onCta?: () => void;
  ctaHref?: string;
  tone?: "pro" | "coming_soon";
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

  return (
    <div className="relative min-h-[60vh]">
      {/* Blurred preview */}
      <div
        aria-hidden
        className="pointer-events-none select-none filter blur-sm opacity-40"
      >
        {children}
      </div>

      {/* Overlay CTA */}
      <div className="absolute inset-0 flex items-start justify-center pt-20">
        <div
          className={`max-w-lg w-full mx-4 p-6 bg-gradient-to-br ${cardClass} border rounded-xl text-center shadow-xl`}
        >
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
        </div>
      </div>
    </div>
  );
}
