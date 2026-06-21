"use client";

import { ModalShell } from "@/components/modal";
import type { DisputeEvidence } from "@/lib/disputes/evidence-resolver";
import type { EvidenceBand } from "@/lib/disputes/strength-scoring";

/**
 * EvidenceStrengthModal (bugbash Item 3) — explains WHY the dispute's evidence
 * band reads the way it does, opened from the "Evidence: {band}" pill in
 * DisputeLetterHero. Reuses the canonical ModalShell primitive (X close, Esc,
 * focus trap) and the data already on the page — it does NOT invent new
 * rationale and NEVER surfaces the raw numeric score (legal constraint §1f L1).
 *
 * Tight copy: one-line framing → "what's strong" (verified citation count) →
 * "what's thin" (the same gap titles shown in the "Strengthen this letter"
 * section below) → a pointer back to that section.
 */

const BAND_LABEL: Record<EvidenceBand, string> = {
  needs_support: "Needs support",
  partially_supported: "Partially supported",
  well_supported: "Well supported",
};

function qualitySummary(
  evidence: DisputeEvidence | null,
): { verified: number; total: number } | null {
  if (!evidence) return null;
  const rows = evidence.claims
    .flatMap((c) => c.lineItemEvidence)
    .filter((li) => li.planBenefit);
  if (rows.length === 0) return null;
  const verified = rows.filter((li) => li.planBenefit?.sbcExcerptVerified).length;
  return { verified, total: rows.length };
}

export function EvidenceStrengthModal({
  open,
  onClose,
  band,
  evidence,
}: {
  open: boolean;
  onClose: () => void;
  band: EvidenceBand;
  evidence: DisputeEvidence | null;
}) {
  const quality = qualitySummary(evidence);
  const gaps = evidence?.gaps ?? [];
  const hasGaps = gaps.length > 0;

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      tone="info"
      size="md"
      title={`Why “${BAND_LABEL[band]}”`}
      subtitle="This grades how well the evidence on file backs your letter — not the odds the insurer agrees."
      footer={
        hasGaps ? (
          <p className="text-xs text-slate-500">
            Add these in <span className="font-semibold text-slate-700">Strengthen this letter</span> below.
          </p>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {quality && quality.verified > 0 ? (
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-emerald-600">
              What’s strong
            </p>
            <div className="flex items-start gap-2 text-sm text-slate-700">
              <CheckIcon />
              <span>
                {quality.verified === quality.total ? "All " : `${quality.verified} of `}
                {quality.total} plan-benefit citation{quality.total === 1 ? "" : "s"}{" "}
                verified against your plan document.
              </span>
            </div>
          </div>
        ) : null}

        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-600">
            {hasGaps ? "What’s thin" : "Looking solid"}
          </p>
          {hasGaps ? (
            <ul className="space-y-1.5">
              {gaps.map((gap, i) => (
                <li key={`${gap.kind}-${i}`} className="flex items-start gap-2 text-sm text-slate-700">
                  <DotIcon />
                  <span>{gap.title}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-700">
              Nothing major outstanding — your evidence is well backed.
            </p>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

function CheckIcon() {
  return (
    <svg
      className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

function DotIcon() {
  return (
    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" aria-hidden />
  );
}
