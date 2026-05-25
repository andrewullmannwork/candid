/**
 * RingMini — small 58px SVG ring metric used inside ProductHero metric slot.
 *
 * Used by the Plan ProductHero on /dashboard. Same visual language as
 * BenefitsScoreboard's 56×56 ring (B1.3b shipped) but inlined into the hero
 * metric area as a compact stat rather than the full scoreboard layout.
 *
 * Per S112 §1.C.1 design dashboard.jsx:196-212.
 */
export function RingMini({ used, total }: { used: number; total: number }) {
  const r = 22;
  const c = 2 * Math.PI * r;
  const safeTotal = total > 0 ? total : 1;
  const offset = c * (1 - used / safeTotal);

  return (
    <svg width="58" height="58" viewBox="0 0 58 58" aria-hidden="true">
      <circle cx="29" cy="29" r={r} fill="none" stroke="rgba(15,23,42,0.08)" strokeWidth="4" />
      <circle
        cx="29"
        cy="29"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={offset}
        transform="rotate(-90 29 29)"
      />
      <text
        x="29"
        y="29"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="16"
        fontWeight="700"
        fill="currentColor"
      >
        {used}/{total}
      </text>
    </svg>
  );
}
