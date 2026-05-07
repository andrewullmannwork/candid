"use client";

/**
 * Share-Candid card — transparent "data is growing" message + email/text invite CTAs.
 *
 * Surfaced at moments of value (compare results, upload completion) to (1) honestly
 * tell users our data coverage is still expanding and (2) give them an easy way to
 * invite friends so the corroboration flywheel turns faster (every new uploader
 * helps verify canonical plans for everyone).
 *
 * Click events emit `share_candid_clicked` to Vercel Analytics with the
 * { surface, channel } tags so we can A/B test placement + measure conversion.
 */

import { track } from "@vercel/analytics";

interface ShareCandidCardProps {
  /** Free-form tag for analytics so we can see which placement converts best.
   *  Examples: "compare_results", "upload_complete", "dashboard". */
  surface: string;
}

const SHARE_URL = "https://candidclaim.com";
const EMAIL_SUBJECT = "Found this — Candid helps decode health insurance";
const EMAIL_BODY = `I've been using Candid to compare health plans + audit medical bills. Plain-English benefits, every number traced back to the source document. Worth a look:\n\n${SHARE_URL}`;
const SMS_BODY = `Found this — Candid decodes health insurance + audits medical bills in plain English: ${SHARE_URL}`;

export function ShareCandidCard({ surface }: ShareCandidCardProps) {
  const mailto = `mailto:?subject=${encodeURIComponent(EMAIL_SUBJECT)}&body=${encodeURIComponent(EMAIL_BODY)}`;
  const sms = `sms:?&body=${encodeURIComponent(SMS_BODY)}`;

  return (
    <div className="mt-10 max-w-3xl mx-auto rounded-3xl bg-gradient-to-br from-blue-50 via-white to-indigo-50 ring-1 ring-blue-100 p-6 sm:p-8 text-center">
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
          onClick={() => track("share_candid_clicked", { surface, channel: "email" })}
          className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-white ring-1 ring-blue-200 text-sm font-semibold text-blue-700 hover:bg-blue-50 hover:ring-blue-300 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          Email a friend
        </a>
        <a
          href={sms}
          onClick={() => track("share_candid_clicked", { surface, channel: "sms" })}
          className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-white ring-1 ring-blue-200 text-sm font-semibold text-blue-700 hover:bg-blue-50 hover:ring-blue-300 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          Text a friend
        </a>
      </div>
    </div>
  );
}
