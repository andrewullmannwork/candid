import { cn } from "@/lib/utils/cn";
import type { ComparePlanPayload } from "@/lib/plan/compare";
import { letterFor, planColorFor } from "./compare-colors";

/**
 * B3.3 — Mobile-only "[A] Plan name" mini-header rendered above each plan cell
 * when the data tables stack to a single column below `sm` breakpoint. On
 * sm+, the column header context (cards above the table) supplies plan
 * identity; on mobile the columns collapse into stacked rows, so each plan
 * cell needs its own letter+name header for context.
 *
 * Hidden via `sm:hidden` — disappears on desktop where columns are visible.
 */

interface MobilePlanLabelProps {
  plan: ComparePlanPayload;
  index: number;
}

export function MobilePlanLabel({ plan, index }: MobilePlanLabelProps) {
  const color = planColorFor(index);
  const letter = letterFor(index);
  return (
    <div className="sm:hidden flex items-center gap-2 mb-1.5">
      <span
        className={cn(
          "shrink-0 w-6 h-6 rounded-md text-white font-bold text-xs flex items-center justify-center shadow-sm",
          color.gradient,
        )}
        aria-hidden="true"
      >
        {letter}
      </span>
      <span className="text-xs font-medium text-slate-600 truncate">
        {plan.planName || `Plan ${letter}`}
      </span>
    </div>
  );
}
