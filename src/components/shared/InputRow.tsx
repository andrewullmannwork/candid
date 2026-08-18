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
  flagged = false,
}: {
  icon: ReactNode;
  label: string;
  /** Optional inline chip after the label (e.g. an "Important" importance tag). */
  badge?: ReactNode;
  control: ReactNode;
  children?: ReactNode;
  below?: ReactNode;
  /**
   * S291/S292 (Andrew) — this row still needs input and the user has tried to
   * finish, so it is pointed at with an amber FULL-BLEED TINT.
   *
   * ⚠ This reverses the original S291 rule ("amber border, never an amber fill")
   * — Andrew's call at S292 after seeing both rendered. The concern behind that
   * rule still stands and is met a different way: the tint is deliberately faint
   * and carries no icon, heading or red/amber text, so the row still reads as
   * highlighted rather than as a warning surface.
   *
   * GEOMETRY — a full-bleed band with NO rules of its own. `-mx-5` cancels the
   * parent card's `px-5` so the tint runs the entire inner width of the card,
   * and the matching `px-5` puts the content back on the same column as every
   * other row, so the icon chips still line up. `first:-mt-1.5` / `last:-mb-4`
   * cancel the parent's own top/bottom padding, so a band at either end reaches
   * the card edge instead of floating in that padding with a strip of white
   * between it and the card border.
   *
   * Three earlier attempts are worth not repeating. `px-3` alone shifted this
   * row's icon and control ~13px inboard of its neighbours. `-mx-3 px-3` fixed
   * that but left the box aligned to neither the card (9px short) nor the
   * content column (12px past) — a rectangle floating between two grids. And a
   * bordered box was, for its whole life, missing its TOP rule whenever it was
   * the first row, because the parent's `[&>div:first-child]:border-t-0` (there
   * to stop a plain first row's divider reading as a stray edge) stripped it —
   * so it rendered as three sides of a box and no amount of width tuning could
   * have fixed it.
   *
   * NO BORDERS AT ALL is what makes this robust rather than merely current: with
   * nothing to be stripped, doubled, or left dangling at a card edge, the whole
   * class of bug above is unreachable. The boundary is a colour change, which
   * needs no alignment.
   *
   * `data-flagged` lets the parent suppress the `border-t` of whatever FOLLOWS a
   * band. Without that, a band would end in a grey divider on its bottom edge
   * and nothing on its top — an asymmetry that reads as a stray line. Both
   * boundaries are now pure colour transitions, and consecutive flagged rows
   * merge into one continuous tinted region, which is the honest reading: they
   * are one block of unfinished work.
   */
  flagged?: boolean;
}) {
  return (
    <div
      data-flagged={flagged ? "true" : undefined}
      className={
        flagged
          ? "-mx-5 bg-amber-50 px-5 py-3.5 first:-mt-1.5 last:-mb-4"
          : "border-t border-gray-100 py-3.5"
      }
    >
      {/* S318 — flex-wrap + a flex-basis on the text column: when the card is
          too narrow for text + control side by side, the CONTROL WRAPS BELOW
          (ml-auto keeps it right-aligned on its own line) instead of either
          failure mode we shipped on the way here — the control's intrinsic
          width collapsing the text to one word per line (the original), or a
          min-w-0 control slot letting buttons bleed past the card edge
          (Andrew's screenshot). Same wrap idiom as the estimates row's
          control pair. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-[1_1_16rem] items-start gap-3">
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
        {/* min-w-0 + max-w-full let a truncatable control (DoneEdit's pill)
            actually ellipsize once it wraps to its own line — without them the
            wrapped line sizes to content and a long plan name runs to the card
            edge with no "…" (Andrew's Leg-6 screenshot). Buttons are
            unaffected: wrap absorbs the squeeze before any shrink pressure
            reaches them. */}
        <div className="ml-auto min-w-0 max-w-full pt-1">{control}</div>
      </div>
      {below != null ? <div className="mt-3 pl-12">{below}</div> : null}
    </div>
  );
}
