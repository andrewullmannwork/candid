import { cn } from "@/lib/utils/cn";

/**
 * BenefitsScoreboard — circular progress ring + verified/total count display.
 *
 * Used on /plan + /dashboard to summarize verification progress for a plan's
 * benefits (per Phase 2 Subplan §1.C.2-K + B1.3b). Pure presentation primitive;
 * no business logic. Caller computes `verifiedCount` + `totalCount` from
 * decorated row state (see consumer-read.ts isVerified-style predicates).
 *
 * Visual:
 *   - 56×56 SVG ring (default `size="md"`); 40×40 ring at `size="sm"` for
 *     dense placements
 *   - Emerald stroke for the verified arc; light-gray remainder
 *   - Center text: "N/M" in tabular nums
 *   - Optional label below ring ("Verified benefits" default)
 *
 * Per D-S112-G: inline Tailwind utilities (no variant CSS). Arc geometry uses
 * stroke-dasharray + stroke-dashoffset trick on a circle for fractional fill.
 */

export type BenefitsScoreboardSize = "sm" | "md";

interface BenefitsScoreboardProps {
  verifiedCount: number;
  totalCount: number;
  /** Label rendered below the ring. Default "Verified benefits". */
  label?: string;
  /** Ring dimension. "md" = 56×56 (default); "sm" = 40×40. */
  size?: BenefitsScoreboardSize;
  className?: string;
}

const SIZES: Record<BenefitsScoreboardSize, {
  outer: number;       // SVG width/height
  radius: number;      // circle r attribute (within outer/2 padding)
  strokeWidth: number;
  centerText: string;  // Tailwind text-size class
  labelText: string;
}> = {
  sm: { outer: 40, radius: 16, strokeWidth: 3.5, centerText: "text-[10px]", labelText: "text-[10px]" },
  md: { outer: 56, radius: 22, strokeWidth: 4.5, centerText: "text-[12px]", labelText: "text-[11px]" },
};

export function BenefitsScoreboard({
  verifiedCount,
  totalCount,
  label = "Verified benefits",
  size = "md",
  className,
}: BenefitsScoreboardProps) {
  const s = SIZES[size];
  const safeTotal = Math.max(totalCount, 0);
  const safeVerified = Math.max(0, Math.min(verifiedCount, safeTotal));
  const fraction = safeTotal === 0 ? 0 : safeVerified / safeTotal;

  const circumference = 2 * Math.PI * s.radius;
  const dashOffset = circumference * (1 - fraction);
  const center = s.outer / 2;

  return (
    <div className={cn("inline-flex flex-col items-center gap-1", className)}>
      <div className="relative" style={{ width: s.outer, height: s.outer }}>
        <svg
          width={s.outer}
          height={s.outer}
          viewBox={`0 0 ${s.outer} ${s.outer}`}
          className="-rotate-90"
          aria-hidden="true"
        >
          {/* Background ring */}
          <circle
            cx={center}
            cy={center}
            r={s.radius}
            fill="none"
            stroke="currentColor"
            strokeWidth={s.strokeWidth}
            className="text-gray-200"
          />
          {/* Progress arc */}
          <circle
            cx={center}
            cy={center}
            r={s.radius}
            fill="none"
            stroke="currentColor"
            strokeWidth={s.strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            className="text-emerald-500 transition-[stroke-dashoffset] duration-300"
          />
        </svg>
        <div
          className={cn(
            "absolute inset-0 flex items-center justify-center font-semibold text-gray-900 tabular-nums",
            s.centerText,
          )}
        >
          {safeVerified}/{safeTotal}
        </div>
      </div>
      {label && (
        <div className={cn("text-gray-500 font-medium", s.labelText)}>
          {label}
        </div>
      )}
    </div>
  );
}
