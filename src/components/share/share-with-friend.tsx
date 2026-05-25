"use client";

/**
 * ShareWithFriend — transparent "data is growing" message + email/text invite CTAs.
 *
 * Renamed from `ShareCandidCard` in S119 B1.3b per Subplan §1.C.4-I. Preserves
 * Vercel Analytics `share_candid_clicked` event tagging + URL constants byte-
 * identically. Adds `variant?: 'soft' | 'full'` dual-prop interface per design
 * `share-with-friend.jsx`.
 *
 * Surfaces (analytics `surface` tag — 5 placements per design Subplan §1.C.4-I):
 *   - "compare_results"    : after compare submission (current)
 *   - "compare_picker"     : new placement on compare picker (B3.3)
 *   - "upload_form"        : on /upload page card (current)
 *   - "upload_complete"    : on parse-terminal success (current)
 *   - "dashboard"          : new placement on /dashboard (B3.1)
 *
 * Variants:
 *   - "full" (default): hero card with gradient bg + decorative blobs, eyebrow,
 *     headline, body, 2 CTA buttons. Matches v1 ShareCandidCard visual byte-for-byte.
 *   - "soft": more subtle in-feed card — smaller padding, no gradient, single
 *     emphasis. For dashboard + compare_picker placements where the share invite
 *     sits next to other content rather than dominating the page.
 *
 * Legacy `<ShareCandidCard>` name preserved via re-export shim at
 * `src/components/share/ShareCandidCard.tsx` to keep existing call sites working
 * during incremental migration (B2.4 + B3.1 surface-by-surface).
 */

import { track } from "@vercel/analytics";
import { cn } from "@/lib/utils/cn";

export type ShareWithFriendVariant = "soft" | "full";

interface ShareWithFriendProps {
  /** Free-form tag for analytics so we can see which placement converts best.
   *  Examples: "compare_results", "upload_complete", "dashboard", "compare_picker". */
  surface: string;
  /** Visual variant. Default "full" preserves the v1 hero card. "soft" is for
   *  in-feed placements like dashboard. */
  variant?: ShareWithFriendVariant;
  /** Optional className override for callers that need spacing tweaks. */
  className?: string;
}

const SHARE_URL = "https://candidclaim.com";
const EMAIL_SUBJECT = "Found this — Candid helps decode health insurance";
const EMAIL_BODY = `I've been using Candid to compare health plans + audit medical bills. Plain-English benefits, every number traced back to the source document. Worth a look:\n\n${SHARE_URL}`;
const SMS_BODY = `Found this — Candid decodes health insurance + audits medical bills in plain English: ${SHARE_URL}`;

export function ShareWithFriend({
  surface,
  variant = "full",
  className,
}: ShareWithFriendProps) {
  const mailto = `mailto:?subject=${encodeURIComponent(
    EMAIL_SUBJECT,
  )}&body=${encodeURIComponent(EMAIL_BODY)}`;
  const sms = `sms:?&body=${encodeURIComponent(SMS_BODY)}`;

  if (variant === "soft") {
    // Soft variant matches design's `.share-card` styling (s112-full-refresh
    // share-with-friend.jsx + styles.css:2856-2905):
    //   - white → blue-50 → green-50 diagonal gradient
    //   - 2 decorative blurred blobs (blue top-left + green bottom-right)
    //   - centered layout, 22px border-radius, blue-600 eyebrow
    //   - "Help us grow." title + extended body copy
    //   - 2 centered secondary buttons (white bg + thin border + blue hover)
    return (
      <div
        className={cn(
          "relative overflow-hidden rounded-[22px] p-7 flex flex-col gap-4 items-center text-center",
          "bg-gradient-to-br from-white via-blue-50 to-green-50",
          "ring-1 ring-blue-100",
          className,
        )}
      >
        {/* Decorative blurred blobs (design .share-blob-1 + .share-blob-2). */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -top-12 -left-10 w-[200px] h-[200px] rounded-full bg-blue-400 opacity-25 blur-[36px]"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-14 -right-10 w-[220px] h-[220px] rounded-full bg-emerald-300 opacity-25 blur-[36px]"
        />

        <div className="relative z-10 max-w-[56ch]">
          <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-blue-600">
            Candid grows with every upload
          </div>
          <h3 className="text-[22px] font-bold tracking-[-0.015em] text-slate-900 mt-1.5">
            Help us grow.
          </h3>
          <p className="text-sm text-slate-600 leading-[1.55] mt-2.5">
            We&rsquo;re still expanding our plan database — some details may be missing today. Every
            plan a friend uploads makes comparisons smarter and audits more accurate for everyone.
          </p>
        </div>

        <div className="relative z-10 flex flex-wrap justify-center gap-2.5">
          <a
            href={mailto}
            onClick={() =>
              track("share_candid_clicked", { surface, channel: "email" })
            }
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white ring-1 ring-gray-200 text-sm font-semibold text-slate-700 hover:ring-blue-300 hover:text-blue-700 hover:-translate-y-0.5 transition-all"
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
              />
            </svg>
            Email a friend
          </a>
          <a
            href={sms}
            onClick={() =>
              track("share_candid_clicked", { surface, channel: "sms" })
            }
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white ring-1 ring-gray-200 text-sm font-semibold text-slate-700 hover:ring-blue-300 hover:text-blue-700 hover:-translate-y-0.5 transition-all"
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
              />
            </svg>
            Text a friend
          </a>
        </div>
      </div>
    );
  }

  // Default "full" variant — preserves v1 ShareCandidCard visual byte-identically.
  return (
    <div
      className={cn(
        "mt-10 max-w-3xl mx-auto rounded-3xl bg-gradient-to-br from-blue-50 via-white to-indigo-50 ring-1 ring-blue-100 p-6 sm:p-8 text-center",
        className,
      )}
    >
      <h3 className="text-base sm:text-lg font-semibold text-slate-900">
        Candid&rsquo;s coverage grows with every upload
      </h3>
      <p className="text-sm text-slate-600 mt-2 leading-relaxed max-w-xl mx-auto">
        We&rsquo;re still expanding our plan database — some details may be
        missing today. Every plan a friend uploads makes comparisons smarter +
        more accurate for everyone. Help us grow:
      </p>
      <div className="mt-5 flex flex-col sm:flex-row gap-2.5 sm:gap-3 justify-center">
        <a
          href={mailto}
          onClick={() =>
            track("share_candid_clicked", { surface, channel: "email" })
          }
          className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-white ring-1 ring-blue-200 text-sm font-semibold text-blue-700 hover:bg-blue-50 hover:ring-blue-300 transition-colors"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
            />
          </svg>
          Email a friend
        </a>
        <a
          href={sms}
          onClick={() =>
            track("share_candid_clicked", { surface, channel: "sms" })
          }
          className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-white ring-1 ring-blue-200 text-sm font-semibold text-blue-700 hover:bg-blue-50 hover:ring-blue-300 transition-colors"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
            />
          </svg>
          Text a friend
        </a>
      </div>
    </div>
  );
}
