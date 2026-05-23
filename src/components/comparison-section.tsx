import { type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

/**
 * ComparisonSection — section wrapper for /compare 3-plan grid surfaces.
 *
 * Renders a section heading + content slot with consistent vertical spacing
 * across the compare page. Used by /compare only (B3.3 consumer). Other
 * surfaces use `<PageHeader>` (top-of-page) or no wrapper.
 *
 * Per Phase 2 Subplan §B1 + D-S112-G full Tailwind utilities (no variant
 * library). Inline-styled via Tailwind; no CSS class family.
 */

interface ComparisonSectionProps {
  title: string;
  /** Optional small descriptive line under the title. */
  description?: string;
  /** Optional right-aligned slot in the heading row (e.g., toggle / link). */
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function ComparisonSection({
  title,
  description,
  right,
  children,
  className,
}: ComparisonSectionProps) {
  return (
    <section className={cn("mt-8 sm:mt-10", className)}>
      <div className="flex items-end justify-between gap-4 mb-3">
        <div className="min-w-0">
          <h2 className="text-lg sm:text-xl font-semibold text-gray-900 tracking-tight">
            {title}
          </h2>
          {description && (
            <p className="mt-1 text-[13px] text-gray-500 leading-relaxed">
              {description}
            </p>
          )}
        </div>
        {right && <div className="flex-shrink-0">{right}</div>}
      </div>
      <div>{children}</div>
    </section>
  );
}
