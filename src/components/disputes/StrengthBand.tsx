import type { EvidenceBand } from "@/lib/disputes/strength-scoring";

/**
 * StrengthBand — Block C2 per-line qualitative evidence readout (§1f L1).
 *
 * Renders ONLY one of three named bands with an ordinal low/mid/high ladder glyph.
 * NEVER a percentage, score, count, or "odds of winning" — the ladder is an ordinal
 * indicator, not a number. Mirrors the letter-level band chip in DisputeLetterHero.
 */
const BAND_PRESENTATION: Record<
  EvidenceBand,
  { label: string; cls: string; lit: number }
> = {
  needs_support: {
    label: "Needs support",
    cls: "border-amber-200 bg-amber-50 text-amber-700",
    lit: 1,
  },
  partially_supported: {
    label: "Partially supported",
    cls: "border-blue-200 bg-blue-50 text-blue-700",
    lit: 2,
  },
  well_supported: {
    label: "Well-supported",
    cls: "border-emerald-300 bg-emerald-50 text-emerald-700",
    lit: 3,
  },
};

const RUNG_HEIGHTS = [5, 8, 11];

export function StrengthBand({ band }: { band: EvidenceBand }) {
  const b = BAND_PRESENTATION[band];
  if (!b) return null;
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11.5px] font-semibold ${b.cls}`}
      title="Qualitative strength — no score or percentage is ever shown"
    >
      <span className="flex items-end gap-0.5" aria-hidden>
        {RUNG_HEIGHTS.map((h, i) => (
          <span
            key={i}
            className={`w-[3px] rounded-full bg-current ${i < b.lit ? "opacity-100" : "opacity-25"}`}
            style={{ height: h }}
          />
        ))}
      </span>
      {b.label}
    </span>
  );
}
