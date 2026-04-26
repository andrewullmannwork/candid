/**
 * EvidenceGaps — surfaces missing-evidence prompts with upload CTAs.
 *
 * Renders below the EvidenceBlock on /disputes when the resolver flagged
 * signals we couldn't populate. Each gap is an actionable card: "Upload
 * your plan → add copay citation." The /disputes page already refetches
 * on window focus, so returning after upload auto-refreshes the letter
 * with the new data.
 */
import Link from "next/link";
import type { EvidenceGap } from "@/lib/disputes/evidence-resolver";

interface Props {
  gaps: EvidenceGap[];
}

export function EvidenceGaps({ gaps }: Props) {
  if (!gaps || gaps.length === 0) return null;
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
      <div className="mb-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Strengthen this letter
        </h3>
        <p className="mt-1 text-sm text-slate-600">
          Add any of the items below and your letter will automatically update
          the next time you return to this page.
        </p>
      </div>
      <ul className="space-y-3">
        {gaps.map((gap, i) => (
          <li
            key={`${gap.kind}-${i}`}
            className="flex flex-col gap-3 rounded-xl border border-slate-100 bg-slate-50/50 px-4 py-3 md:flex-row md:items-center md:justify-between"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <GapIcon />
                <div className="font-semibold text-slate-900">{gap.title}</div>
              </div>
              <p className="mt-1 pl-6 text-sm text-slate-600">{gap.description}</p>
            </div>
            {gap.ctaLabel && gap.ctaHref ? (
              <Link
                href={gap.ctaHref}
                className="inline-flex shrink-0 items-center justify-center rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-px hover:bg-blue-700 hover:shadow md:ml-4"
              >
                {gap.ctaLabel}
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function GapIcon() {
  return (
    <svg
      className="h-4 w-4 text-amber-500"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
      aria-hidden
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}
