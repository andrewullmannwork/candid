/**
 * B3.3 — Pure derivation helpers for /compare aggregate displays.
 *
 * No backend calls; all derived from the `ComparePlanPayload[]` cohort the
 * /api/plan/compare endpoint returns. Best-in-row badges, breadth counts,
 * category coverage, per-category grouping all derived here.
 *
 * NON-NEGOTIABLE: ties get "Best" on all tied plans (honest); plans with null
 * values are excluded from comparison; single-plan cohorts skip best-derivation
 * entirely (no comparison meaningful).
 */

import { unwrapValue } from "@/components/display-state";
import type { ComparePlanPayload, CompareBenefit } from "@/lib/plan/compare";

// ── Numeric extraction ────────────────────────────────────────────────────

/** Extract numeric value from a decorated-or-raw cell. Returns null when no value. */
export function asNumber(value: unknown): number | null {
  const v = unwrapValue<number | null>(value as never);
  return typeof v === "number" && !Number.isNaN(v) ? v : null;
}

/** Whole-dollar currency formatter ($5,800 — never cents). Shared across v2 cells. */
export function usd(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

// ── Best-in-row derivation ────────────────────────────────────────────────

/**
 * Returns indices of plans tied for the best value per `accessor`.
 *
 * @param invert true when LOWER is better (premium, deductible, OOP, copay);
 *               false when HIGHER is better (covered count, category coverage).
 * Plans with null values are excluded from comparison.
 * Returns empty array when ≤1 plan provided OR all plans have null values.
 */
export function bestNumericIndices<T>(
  plans: T[],
  accessor: (plan: T) => number | null,
  invert: boolean,
): number[] {
  if (plans.length <= 1) return [];
  const populated = plans
    .map((p, i) => ({ v: accessor(p), i }))
    .filter((entry): entry is { v: number; i: number } => entry.v != null);
  if (populated.length === 0) return [];
  const best = invert
    ? Math.min(...populated.map((p) => p.v))
    : Math.max(...populated.map((p) => p.v));
  return populated.filter((p) => p.v === best).map((p) => p.i);
}

// ── Breadth + category coverage ───────────────────────────────────────────

/** Per-plan distinct categories covered (excluding 'other' — that's a catch-all). */
export function categoryCoveragePerPlan(plans: ComparePlanPayload[]): number[] {
  return plans.map((p) => {
    const categories = new Set<string>();
    for (const b of p.benefits) {
      if (b.covered === false) continue;
      if (b.category && b.category !== "other") categories.add(b.category);
    }
    return categories.size;
  });
}

/** Union of all distinct categories across the cohort (excluding 'other'). */
export function distinctCategoriesAcrossCohort(plans: ComparePlanPayload[]): number {
  const set = new Set<string>();
  for (const p of plans) {
    for (const b of p.benefits) {
      if (b.category && b.category !== "other") set.add(b.category);
    }
  }
  return set.size;
}

// ── Per-category grouping for service-by-service accordions ───────────────

export interface ServiceRowAcrossPlans {
  serviceSlug: string;
  /** S289 Phase B — unique row identity: slug + Pattern-S variant modifiers. */
  variantKey: string;
  title: string;
  perPlan: Array<CompareBenefit | null>;
}

export interface CategoryGroup {
  category: string;
  rows: ServiceRowAcrossPlans[];
}

/**
 * S289 Phase B — human label for a variant's Pattern-S modifiers, shown only
 * when a slug has >1 variant in the cohort ("Surgery — facility" vs a lone
 * "Surgery"). Exported for the fixture.
 */
export function variantLabel(b: CompareBenefit): string {
  const parts: string[] = [];
  const pos = b.placeOfService ?? "any";
  const component = b.component ?? "global";
  const tier = b.planTierLabel ?? "none";
  if (pos !== "any") parts.push(pos.replace(/_/g, " "));
  if (component !== "global") parts.push(component.replace(/_/g, " "));
  if (tier !== "none") parts.push(tier.replace(/_/g, " "));
  return parts.join(" · ");
}

function variantKeyOf(b: CompareBenefit): string {
  return `${b.serviceSlug}|${b.placeOfService ?? "any"}|${b.component ?? "global"}|${b.planTierLabel ?? "none"}`;
}

/**
 * Group benefits across plans by category. One row PER VARIANT
 * (slug + place_of_service + component + plan_tier_label), each holding the
 * per-plan benefit (or null when a plan lacks that variant — rendered as an
 * empty cell, compare's native missing-service treatment). Categories with no
 * eligible services are dropped.
 *
 * S289 Phase B: rows were previously keyed per SLUG with
 * `perPlan[planIdx] = benefit` per variant — the LAST variant won, and the
 * feeding queries had no ORDER BY, so WHICH cost a multi-variant service
 * displayed was Postgres heap order: nondeterministic. Now every variant is a
 * first-class row; when a slug has multiple variants in the cohort, titles
 * carry the modifier qualifier ("Surgery — facility").
 */
export function groupBenefitsByCategory(
  plans: ComparePlanPayload[],
): CategoryGroup[] {
  const byCategory = new Map<
    string,
    Map<string, { serviceSlug: string; title: string; label: string; perPlan: Array<CompareBenefit | null> }>
  >();
  const variantsPerSlug = new Map<string, Set<string>>();
  for (let planIdx = 0; planIdx < plans.length; planIdx++) {
    for (const benefit of plans[planIdx].benefits) {
      const category = benefit.category || "other";
      const slug = benefit.serviceSlug;
      if (!slug) continue;
      const key = variantKeyOf(benefit);
      (variantsPerSlug.get(slug) ?? variantsPerSlug.set(slug, new Set()).get(slug)!).add(key);
      if (!byCategory.has(category)) byCategory.set(category, new Map());
      const rowMap = byCategory.get(category)!;
      if (!rowMap.has(key)) {
        rowMap.set(key, {
          serviceSlug: slug,
          title: benefit.title,
          label: variantLabel(benefit),
          perPlan: new Array(plans.length).fill(null),
        });
      }
      rowMap.get(key)!.perPlan[planIdx] = benefit;
    }
  }

  const groups: CategoryGroup[] = [];
  for (const [category, rowMap] of byCategory) {
    const rows: ServiceRowAcrossPlans[] = [];
    for (const [variantKey, { serviceSlug, title, label, perPlan }] of rowMap) {
      const multiVariant = (variantsPerSlug.get(serviceSlug)?.size ?? 1) > 1;
      rows.push({
        serviceSlug,
        variantKey,
        title: multiVariant && label ? `${title} — ${label}` : title,
        perPlan,
      });
    }
    rows.sort(
      (a, b) => a.title.localeCompare(b.title) || a.variantKey.localeCompare(b.variantKey),
    );
    groups.push({ category, rows });
  }
  return groups;
}

/**
 * Stable display order for category accordions (slug → label).
 *
 * S289: keys are service_catalog.category values (the vocabulary
 * groupBenefitsByCategory actually receives). The original list used four
 * invented slugs (office_visits/prescriptions/equipment/home_health) plus two
 * that no category can hold (specialist/pediatric) — those groups fell to
 * title-cased fallbacks ("Office Visit", "Rx", "Dme") sorted at 999, AFTER
 * "Other covered services".
 */
export const CATEGORY_DISPLAY_ORDER: Array<{ slug: string; label: string }> = [
  { slug: "office_visit", label: "Office visits" },
  { slug: "preventive", label: "Preventive care" },
  { slug: "emergency", label: "Emergency & urgent care" },
  { slug: "hospital", label: "Hospital services" },
  { slug: "hospitalization", label: "Hospital stays" },
  { slug: "surgery", label: "Surgery" },
  { slug: "imaging", label: "Imaging" },
  { slug: "lab", label: "Lab & diagnostics" },
  { slug: "rx", label: "Prescriptions" },
  { slug: "mental_health", label: "Mental health & substance use" },
  { slug: "therapy", label: "Therapy & rehab" },
  { slug: "dialysis", label: "Dialysis" },
  { slug: "maternity", label: "Maternity & newborn" },
  { slug: "family_planning", label: "Family planning" },
  { slug: "vision", label: "Vision" },
  { slug: "dental", label: "Dental" },
  { slug: "dme", label: "Equipment & supplies" },
  { slug: "long_term_care", label: "Home health & long-term care" },
  { slug: "other", label: "Other covered services" },
];

/** Sort category groups by CATEGORY_DISPLAY_ORDER; unknown categories appended in title-case. */
export function sortCategoryGroups(
  groups: CategoryGroup[],
): Array<CategoryGroup & { label: string }> {
  const orderIdx = new Map(CATEGORY_DISPLAY_ORDER.map((c, i) => [c.slug, i]));
  const labelMap = new Map(CATEGORY_DISPLAY_ORDER.map((c) => [c.slug, c.label]));
  return groups
    .map((g) => ({
      group: g,
      label: labelMap.get(g.category) ?? toTitleCase(g.category),
      order: orderIdx.get(g.category) ?? 999,
    }))
    .sort((a, b) => a.order - b.order)
    .map(({ group, label }) => ({ ...group, label }));
}

function toTitleCase(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Per-service / per-category metric helpers ─────────────────────────────

/** Per-service in-network copay extraction for best-row derivation. */
export function inNetworkCopay(b: CompareBenefit | null): number | null {
  if (!b || b.covered === false) return null;
  return asNumber(b.costSharing?.inNetwork?.copay);
}

/** Per-plan wins in a category (rows where this plan has the lowest in-network copay). */
export function winsPerPlanInCategory(
  rows: ServiceRowAcrossPlans[],
  planCount: number,
): number[] {
  const wins = new Array(planCount).fill(0);
  for (const row of rows) {
    const bestIdx = bestNumericIndices(row.perPlan, inNetworkCopay, true);
    for (const i of bestIdx) wins[i] += 1;
  }
  return wins;
}

/** Per-plan covered count in a category (rows where this plan has covered !== false). */
export function coveredPerPlanInCategory(
  rows: ServiceRowAcrossPlans[],
  planCount: number,
): number[] {
  const covered = new Array(planCount).fill(0);
  for (const row of rows) {
    for (let i = 0; i < planCount; i++) {
      const b = row.perPlan[i];
      if (b && b.covered !== false) covered[i] += 1;
    }
  }
  return covered;
}
