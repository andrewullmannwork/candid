/**
 * Shared "input row" primitive — icon chip + label + a "why it matters" sub-line +
 * a right-aligned control, stacked as border-t divider rows inside one card.
 *
 * Extracted from CostShareBanner (Cost-Share v2) so the dispute-page Zone-1
 * "What we need from you" panel (CaseNeedsPanel) reuses the exact same row shape
 * per the dispute-letters v2 design (map §6). Pure presentational; no state.
 */
import { type ReactNode } from "react";

/** Icon container chip — a 36px rounded square holding a small glyph. */
export function IconChip({ children }: { children: ReactNode }) {
  return (
    <div className="grid h-9 w-9 flex-none place-items-center rounded-xl bg-gray-100 text-gray-500">
      {children}
    </div>
  );
}

/**
 * One row: icon chip + label + optional "why it matters" sub-line (children) + a
 * right-aligned control, with an optional full-width `below` slot (an expanded editor,
 * aligned under the label) for the "expand to add a value" pattern. `children` and
 * `below` are optional so a resolved ("Done") row omits the sub-line and callers that
 * pass neither render byte-identically to before. `min-w-0` lets long labels wrap
 * instead of overflowing the control (mobile-safe).
 */
export function Row({
  icon,
  label,
  badge,
  control,
  children,
  below,
}: {
  icon: ReactNode;
  label: string;
  /** Optional inline chip after the label (e.g. an "Important" importance tag). */
  badge?: ReactNode;
  control: ReactNode;
  children?: ReactNode;
  below?: ReactNode;
}) {
  return (
    <div className="border-t border-gray-100 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <IconChip>{icon}</IconChip>
          <div className="min-w-0 pt-0.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="text-sm font-medium text-gray-900">{label}</span>
              {badge != null ? badge : null}
            </div>
            {children != null && children !== "" ? (
              <div className="mt-0.5 text-[13px] leading-snug text-gray-600">{children}</div>
            ) : null}
          </div>
        </div>
        <div className="pt-1">{control}</div>
      </div>
      {below != null ? <div className="mt-3 pl-12">{below}</div> : null}
    </div>
  );
}
