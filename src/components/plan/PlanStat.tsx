import { type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

/**
 * PlanStat — 4-grid stat tile (label / value / sub).
 *
 * Used in /plan card chrome for Deductible IN/OON + OOP Max IN/OON (B3.2 per
 * §1.C.2 design). Pure presentation; caller supplies pre-formatted value (the
 * decorated cite-grade fallback rendering — italic verbatim phrase when
 * `field.reason === "from_user_document_conditional_context"` per Session 77 —
 * is passed in as `value` so this primitive stays presentation-only).
 *
 * Per D-S112-G: inline Tailwind utilities; no variant CSS.
 */

interface PlanStatProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  className?: string;
}

export function PlanStat({ label, value, sub, className }: PlanStatProps) {
  return (
    <div className={cn("min-w-0", className)}>
      <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">
        {label}
      </p>
      <p className="mt-0.5 text-sm font-medium text-gray-900 leading-tight">
        {value}
      </p>
      {sub && (
        <p className="mt-0.5 text-[11px] text-gray-400 leading-tight">{sub}</p>
      )}
    </div>
  );
}
