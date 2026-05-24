"use client";
/**
 * Visual credit card render — mirrors the design's `bl-card` chrome.
 * Pure display; no Stripe API calls.
 *
 * Cardholder name + expiry are sourced from /api/subscription/me; brand and
 * last4 are denormalized to `stripe_customers` so we don't round-trip Stripe
 * on every /billing render.
 */

interface VisualCreditCardProps {
  brand: string | null;
  last4: string | null;
  cardholderName: string | null;
  expMonth: number | null;
  expYear: number | null;
}

function formatBrand(brand: string | null): string {
  if (!brand) return "CARD";
  return brand.toUpperCase();
}

function formatExpiry(month: number | null, year: number | null): string {
  if (!month || !year) return "—— / ——";
  const mm = String(month).padStart(2, "0");
  const yy = String(year).slice(-2);
  return `${mm} / ${yy}`;
}

export function VisualCreditCard({
  brand,
  last4,
  cardholderName,
  expMonth,
  expYear,
}: VisualCreditCardProps) {
  return (
    <div className="relative w-full max-w-[320px] overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-slate-800 to-slate-700 p-5 text-white shadow-lg">
      <div className="text-[11px] font-bold tracking-[0.15em] text-slate-300">
        {formatBrand(brand)}
      </div>
      <div className="mt-5 h-7 w-10 rounded bg-gradient-to-br from-amber-200 via-yellow-400 to-amber-500 shadow-inner" />
      <div className="mt-5 flex gap-3 font-mono text-[15px] tracking-widest text-white">
        <span>••••</span>
        <span>••••</span>
        <span>••••</span>
        <span>{last4 || "————"}</span>
      </div>
      <div className="mt-5 flex items-end justify-between">
        <div>
          <div className="text-[9px] font-semibold uppercase tracking-[0.15em] text-slate-400">
            Holder
          </div>
          <div className="mt-0.5 text-[12px] font-medium uppercase tracking-wider text-white">
            {cardholderName || "Card on file"}
          </div>
        </div>
        <div>
          <div className="text-[9px] font-semibold uppercase tracking-[0.15em] text-slate-400">
            Expires
          </div>
          <div className="mt-0.5 text-[12px] font-medium tracking-wider text-white">
            {formatExpiry(expMonth, expYear)}
          </div>
        </div>
      </div>
    </div>
  );
}
