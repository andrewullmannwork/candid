/**
 * B3.3 — Per-plan visual constants + corroboration copy helper for /compare.
 *
 * Color set sourced from Phase 1 design handoff
 * (plans/findings/design-handoffs/s112-full-refresh/project/compare.jsx) —
 * 3 gradients mapped to slots A/B/C. Used by PlanSlot picker chrome + plan
 * summary cards + (optionally) per-cell data-plan markers.
 */

export interface ComparePlanColor {
  /** Tailwind class for gradient bg (avatars + accents). */
  gradient: string;
  /** Tailwind class for solid bg (markers + borders). */
  solid: string;
  /** Solid color hex (e.g., for inline border style or data-plan attribute). */
  hex: string;
  /** S289 — light sub-card treatment (ring + wash) in this plan's hue. */
  tint: string;
  /** S289 — hover companion for `solid` (one step darker), for buttons in this plan's hue. */
  solidHover: string;
}

export const COMPARE_PLAN_COLORS: ComparePlanColor[] = [
  // Slot A — blue (design #2563eb → #1d4ed8)
  { gradient: "bg-gradient-to-br from-blue-600 to-blue-700", solid: "bg-blue-600", hex: "#2563eb", tint: "ring-blue-200 bg-blue-50/70", solidHover: "hover:bg-blue-700" },
  // Slot B — purple (design #7e22ce → #6b21a8)
  { gradient: "bg-gradient-to-br from-purple-700 to-purple-800", solid: "bg-purple-700", hex: "#7e22ce", tint: "ring-purple-200 bg-purple-50/70", solidHover: "hover:bg-purple-800" },
  // Slot C — pink (design #db2777 → #be185d)
  { gradient: "bg-gradient-to-br from-pink-600 to-pink-700", solid: "bg-pink-600", hex: "#db2777", tint: "ring-pink-200 bg-pink-50/70", solidHover: "hover:bg-pink-700" },
];

export function letterFor(idx: number): string {
  return String.fromCharCode(65 + idx);
}

export function planColorFor(idx: number): ComparePlanColor {
  return COMPARE_PLAN_COLORS[idx] ?? COMPARE_PLAN_COLORS[0];
}

/**
 * Bucketed corroboration copy per D-§1.C.3-J.
 *
 * count > 10 → "Verified by {10|100|1,000|10,000}+ members on the same plan"
 *              (power-of-10 floor — never overstates)
 * count ≤ 10 (incl. 0/null) → "Verified by the Candid community"
 *              (no number; avoids exposing low counts that undermine trust)
 */
export function getCorroborationCopy(count: number | null | undefined): string {
  if (count == null || count <= 10) {
    return "Community verified";
  }
  const bucket = Math.pow(10, Math.floor(Math.log10(count)));
  return `Verified by ${bucket.toLocaleString()}+ members on the same plan`;
}
