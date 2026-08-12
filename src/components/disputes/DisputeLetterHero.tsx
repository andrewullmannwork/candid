/**
 * DisputeLetterHero — Phase 2 visual polish
 *
 * Gradient hero strip at the top of /disputes. Replaces the legacy plain
 * "Dispute Letter" heading with:
 *   - Eyebrow: DISPUTE LETTER · DRAFT (small caps)
 *   - Title: "Appeal — {provider} · {service date}"
 *   - Subtitle: one-line summary of the ask
 *   - Right pill: +${recovery} potential recovery (when > 0)
 *
 * S74 Pillar 2: letter quality summary chip below the title shows how many of
 * the plan-benefit citations are cite-grade verified ("X of Y verified") plus
 * a "Re-draft to upgrade" hint when at least one is not. Wires to the toolbar
 * Re-draft callback so the user can act from the hero rather than scrolling.
 */
import type { DisputeLetter } from "@/lib/billing/types";
import type { DisputeEvidence } from "@/lib/disputes/evidence-resolver";
import { plainDate, easternDate } from "@/lib/format/dates";
import type { StrengthResult, EvidenceBand } from "@/lib/disputes/strength-scoring";

interface Props {
  letter: DisputeLetter;
  providerName: string | null;
  serviceDate: string | null;
  askSummary: string | null;
  potentialRecovery: number | null;
  /** S74 — drives the cite-grade quality summary. */
  evidence?: DisputeEvidence | null;
  /**
   * Block C (dispute_letter_v3_design) — three-axis strength. When present, the
   * hero renders the evidence-strength band as a qualitative chip (§1a readout).
   * Optional + only passed by the v3 UI, so the flag-OFF hero is unchanged.
   */
  strength?: StrengthResult | null;
  /** S74 — called when the user clicks the "Re-draft to upgrade" link in the
   *  quality summary chip. Should run the same redraft POST as the toolbar. */
  onRedraft?: () => void;
  /** Disables the redraft link while a redraft is already in flight. */
  redraftInFlight?: boolean;
  /**
   * Bugbash Item 3 — when set, the "Evidence: {band}" chip becomes a button
   * that opens the explanation modal. Omitted callers render the chip as a
   * static span (unchanged).
   */
  onBandClick?: () => void;
}

const LETTER_TYPE_EYEBROW: Record<DisputeLetter["letterType"], string> = {
  insurance_appeal: "DISPUTE LETTER · APPEAL · DRAFT",
  overcharge: "DISPUTE LETTER · OVERCHARGE · DRAFT",
  balance_billing: "DISPUTE LETTER · BALANCE BILLING · DRAFT",
  duplicate_charge: "DISPUTE LETTER · DUPLICATE CHARGE · DRAFT",
  itemized_request: "LETTER · ITEMIZED BILL REQUEST · DRAFT",
  negotiation: "LETTER · SELF-PAY NEGOTIATION · DRAFT",
  final_notice: "DISPUTE LETTER · FINAL NOTICE · DRAFT",
  external_review: "DISPUTE LETTER · EXTERNAL REVIEW · DRAFT",
  debt_validation: "LETTER · DEBT VALIDATION · DRAFT",
};

export function DisputeLetterHero({
  letter,
  providerName,
  serviceDate,
  askSummary,
  potentialRecovery,
  evidence,
  strength,
  onRedraft,
  redraftInFlight,
  onBandClick,
}: Props) {
  const title = [
    titleForType(letter.letterType),
    providerName,
    serviceDate ? formatServiceDate(serviceDate) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const qualitySummary = computeQualitySummary(evidence);
  // Block C — evidence-strength band (§1a). Qualitative only; the numeric
  // score is never surfaced (§1f L1 — evidence quality, not odds of winning).
  const band = strength ? bandPresentation(strength.evidenceStrength.band) : null;

  return (
    <div className="relative overflow-hidden rounded-2xl border border-blue-100 bg-gradient-to-br from-blue-50 via-indigo-50 to-white px-6 py-7 shadow-sm md:px-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-blue-700/80">
            {LETTER_TYPE_EYEBROW[letter.letterType]}
          </p>
          <h1 className="mt-2 text-2xl font-bold leading-tight text-slate-900 md:text-[28px]">
            {title || "Draft dispute letter"}
          </h1>
          {askSummary ? (
            <p className="mt-2 max-w-2xl text-sm text-slate-600 md:text-base">
              {askSummary}
            </p>
          ) : null}
          {band || qualitySummary ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {band ? (
                onBandClick ? (
                  <button
                    type="button"
                    onClick={onBandClick}
                    aria-haspopup="dialog"
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition hover:brightness-95 ${band.chip}`}
                    title="Why this rating? — see what's backing this dispute and what would strengthen it."
                  >
                    <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${band.dot}`} />
                    Evidence: {band.label}
                    <svg aria-hidden className="h-3 w-3 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M12 16v-4M12 8h.01" />
                    </svg>
                  </button>
                ) : (
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${band.chip}`}
                    title="How well-backed this dispute is by the evidence on file — a measure of evidence quality, not a prediction of whether the insurer will agree."
                  >
                    <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${band.dot}`} />
                    Evidence: {band.label}
                  </span>
                )
              ) : null}
              {qualitySummary ? (
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${
                    qualitySummary.allVerified
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : qualitySummary.verified === 0
                      ? "border-amber-200 bg-amber-50 text-amber-800"
                      : "border-indigo-200 bg-indigo-50 text-indigo-700"
                  }`}
                  title={qualitySummary.allVerified
                    ? "Every plan-benefit citation in this letter is backed by a verbatim quote from your plan document (or a corroborating member's parse)."
                    : "Some plan-benefit citations don't yet have a verbatim plan-document quote. Re-draft attempts a cite-grade upgrade via a bounded re-parse."}
                >
                  <QualityDot allVerified={qualitySummary.allVerified} />
                  {qualitySummary.verified} of {qualitySummary.total} citation{qualitySummary.total === 1 ? "" : "s"} verified
                </span>
              ) : null}
              {qualitySummary && !qualitySummary.allVerified && onRedraft ? (
                <button
                  type="button"
                  onClick={onRedraft}
                  disabled={redraftInFlight}
                  className="text-xs font-medium text-blue-700 underline-offset-2 hover:underline disabled:opacity-50"
                >
                  {redraftInFlight ? "Re-drafting…" : "Re-draft to upgrade"}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        {potentialRecovery != null && potentialRecovery > 0 ? (
          <div className="shrink-0">
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-emerald-700">
              <span aria-hidden>+</span>
              {formatUsd(potentialRecovery)} potential recovery
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function computeQualitySummary(
  evidence: DisputeEvidence | null | undefined,
): { verified: number; total: number; allVerified: boolean } | null {
  if (!evidence) return null;
  const rows = evidence.claims.flatMap((c) => c.lineItemEvidence).filter((li) => li.planBenefit);
  if (rows.length === 0) return null;
  const verified = rows.filter((li) => li.planBenefit?.sbcExcerptVerified).length;
  return { verified, total: rows.length, allVerified: verified === rows.length };
}

function bandPresentation(
  band: EvidenceBand,
): { label: string; chip: string; dot: string } {
  switch (band) {
    case "well_supported":
      return {
        label: "Well supported",
        chip: "border-emerald-200 bg-emerald-50 text-emerald-700",
        dot: "bg-emerald-500",
      };
    case "partially_supported":
      return {
        label: "Partially supported",
        chip: "border-indigo-200 bg-indigo-50 text-indigo-700",
        dot: "bg-indigo-500",
      };
    case "needs_support":
    default:
      return {
        label: "Needs support",
        chip: "border-amber-200 bg-amber-50 text-amber-800",
        dot: "bg-amber-500",
      };
  }
}

function QualityDot({ allVerified }: { allVerified: boolean }) {
  return (
    <span
      aria-hidden
      className={`h-1.5 w-1.5 rounded-full ${allVerified ? "bg-emerald-500" : "bg-amber-500"}`}
    />
  );
}

function titleForType(type: DisputeLetter["letterType"]): string {
  switch (type) {
    case "insurance_appeal":
      return "Appeal";
    case "overcharge":
      return "Billing dispute";
    case "balance_billing":
      return "Balance billing dispute";
    case "duplicate_charge":
      return "Duplicate charge dispute";
    case "itemized_request":
      return "Itemized bill request";
    case "negotiation":
      return "Self-pay negotiation";
    case "final_notice":
      return "Final notice";
    case "external_review":
      return "External review request";
    case "debt_validation":
      return "Debt validation";
    default: {
      // Exhaustiveness guard — a new letter type without a title here is a compile error.
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

function formatServiceDate(iso: string): string {
  try {
    // S311 (F13's two value classes, reaching this page): a DATE-ONLY DoS
    // ("2023-08-02") is UTC-pinned and never shifts — the local-timezone parse
    // this replaced rendered it "August 1" in PDT while the letter said
    // "August 2". The instant fallback (letter.createdAt) renders on the
    // user's Eastern calendar like every letter dateline.
    return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? plainDate(iso) : easternDate(iso);
  } catch {
    return iso;
  }
}

function formatUsd(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return `$${rounded.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
