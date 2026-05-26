/**
 * B3.3 — Shared grid column template for results-view tables.
 *
 * Responsive: stacks 1-col on mobile (below sm = 640px) so the comparison
 * doesn't horizontally scroll, then switches to the label + N plan columns
 * grid on sm+. All three tables (NumbersTable / BreadthTable /
 * ServiceCategoryAccordions service rows) MUST use the same template so
 * columns align vertically across sections on sm+.
 *
 * Mobile rendering: each row becomes a stacked card — label cell on top
 * acts as a section header, per-plan cells stacked below with a
 * MobilePlanLabel mini-header (letter + plan name) inside each.
 */

// `minmax(0,1fr)` forces equal column widths regardless of content.
// Plain `1fr` is `minmax(auto, 1fr)` — when one cell has wide content (e.g.,
// "$11,600 BEST" inline) and siblings show "—", the wide cell expands beyond
// 1/Nth, breaking visual alignment. minmax(0,1fr) caps min-content at 0; cells
// wrap internally instead (paired with `flex-wrap` on value+badge clusters).
const COMPARE_GRID_SM_COLS: Record<number, string> = {
  1: "sm:grid-cols-[minmax(140px,180px)_minmax(0,1fr)]",
  2: "sm:grid-cols-[minmax(140px,180px)_minmax(0,1fr)_minmax(0,1fr)]",
  3: "sm:grid-cols-[minmax(140px,180px)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]",
};

export function compareGridClass(planCount: number): string {
  const smCols = COMPARE_GRID_SM_COLS[planCount] ?? COMPARE_GRID_SM_COLS[3];
  return `grid-cols-1 ${smCols}`;
}

/**
 * Same template as `compareGridClass` but as `lg:` responsive classes only —
 * for PlanSummaryCards which stack 1-col on mobile and align to data columns
 * (with the "THE PLANS" label in the label column) on lg+.
 */
const COMPARE_CARDS_GRID_LG: Record<number, string> = {
  1: "lg:grid-cols-[minmax(140px,180px)_minmax(0,1fr)]",
  2: "lg:grid-cols-[minmax(140px,180px)_minmax(0,1fr)_minmax(0,1fr)]",
  3: "lg:grid-cols-[minmax(140px,180px)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]",
};

export function cardsGridLgClass(planCount: number): string {
  return COMPARE_CARDS_GRID_LG[planCount] ?? COMPARE_CARDS_GRID_LG[3];
}
