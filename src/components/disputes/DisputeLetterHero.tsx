/**
 * DisputeLetterHero — Phase 2 visual polish
 *
 * Gradient hero strip at the top of /disputes. Replaces the legacy plain
 * "Dispute Letter" heading with:
 *   - Eyebrow: DISPUTE LETTER · DRAFT (small caps)
 *   - Title: "Appeal — {provider} · {service date}"
 *   - Subtitle: one-line summary of the ask
 *   - Right pill: +${recovery} potential recovery (when > 0)
 */
import type { DisputeLetter } from "@/lib/billing/types";

interface Props {
  letter: DisputeLetter;
  providerName: string | null;
  serviceDate: string | null;
  askSummary: string | null;
  potentialRecovery: number | null;
}

const LETTER_TYPE_EYEBROW: Record<DisputeLetter["letterType"], string> = {
  insurance_appeal: "DISPUTE LETTER · APPEAL · DRAFT",
  overcharge: "DISPUTE LETTER · OVERCHARGE · DRAFT",
  balance_billing: "DISPUTE LETTER · BALANCE BILLING · DRAFT",
  duplicate_charge: "DISPUTE LETTER · DUPLICATE CHARGE · DRAFT",
  itemized_request: "LETTER · ITEMIZED BILL REQUEST · DRAFT",
  negotiation: "LETTER · SELF-PAY NEGOTIATION · DRAFT",
};

export function DisputeLetterHero({
  letter,
  providerName,
  serviceDate,
  askSummary,
  potentialRecovery,
}: Props) {
  const title = [
    titleForType(letter.letterType),
    providerName,
    serviceDate ? formatServiceDate(serviceDate) : null,
  ]
    .filter(Boolean)
    .join(" · ");

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
  }
}

function formatServiceDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function formatUsd(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return `$${rounded.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
