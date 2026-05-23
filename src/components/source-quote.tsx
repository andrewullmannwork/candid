import { type ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

/**
 * SourceQuote — cite-grade emerald blockquote for verbatim source excerpts.
 *
 * Used wherever Candid cites a verbatim quote from a parsed document:
 *   - dispute letters (Pattern P-8 cite-grade gate)
 *   - benefit rows on /plan
 *   - any surface that needs to show "this is the exact text from the doc"
 *
 * Per design Bundle s116-followup-designs/batch-1-primitives/SourceQuote.jsx,
 * adapted to inline Tailwind utilities per D-S112-G (no .sq-* CSS family).
 */

export type SourceQuoteState = 'verified' | 'candid_verified' | 'community';

interface SourceQuoteProps {
  quote: ReactNode;
  source: string;
  page?: number | string;
  doctype?: string;
  state?: SourceQuoteState;
  meta?: ReactNode;
  className?: string;
}

const STATES: Record<SourceQuoteState, {
  borderLeft: string;
  bgFrom: string;
  ink: string;
  label: string;
}> = {
  verified: {
    borderLeft: 'border-l-emerald-300',
    bgFrom: 'from-emerald-50',
    ink: 'text-emerald-700',
    label: 'Verified from',
  },
  candid_verified: {
    borderLeft: 'border-l-emerald-400',
    bgFrom: 'from-emerald-50',
    ink: 'text-emerald-800',
    label: 'Candid Verified from',
  },
  community: {
    borderLeft: 'border-l-green-200',
    bgFrom: 'from-green-50',
    ink: 'text-green-700',
    label: 'Community-corroborated from',
  },
};

export function SourceQuote({
  quote,
  source,
  page,
  doctype,
  state = 'verified',
  meta,
  className,
}: SourceQuoteProps) {
  const s = STATES[state];

  return (
    <figure
      className={cn(
        'border-l-4 rounded-r-xl pl-4 pr-4 py-3 my-2',
        'bg-gradient-to-b to-white',
        s.borderLeft,
        s.bgFrom,
        className,
      )}
    >
      <blockquote className="relative text-[14px] text-gray-800 leading-relaxed">
        <span
          aria-hidden="true"
          className={cn(
            'absolute -left-1 -top-1 text-[28px] font-bold leading-none opacity-30',
            s.ink,
          )}
        >
          &ldquo;
        </span>
        <span className="relative pl-3">{quote}</span>
      </blockquote>

      <figcaption className={cn('mt-2 flex items-center flex-wrap gap-1.5 text-[12px] font-medium', s.ink)}>
        <span aria-hidden="true" className="inline-flex items-center">
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 13l4 4L19 7" />
          </svg>
        </span>
        <span>{s.label}</span>
        <strong className="font-semibold">{source}</strong>
        {doctype && <span className="opacity-75">· {doctype}</span>}
        {page !== undefined && <span className="opacity-75">· p.{page}</span>}
        {meta && <span className="ml-auto opacity-75">{meta}</span>}
      </figcaption>
    </figure>
  );
}
