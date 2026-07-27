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
import {
  pickRepresentativeVariant,
  type ComparePlanPayload,
  type CompareBenefit,
} from "@/lib/plan/compare";

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
  // S289 review F1 — "best" requires COMPETITION: with <2 populated values
  // there is nothing to win. Pre-variant-rows this fired only when a plan
  // lacked a slug entirely; variant rows made single-populated rows common
  // (disjoint variant sets), and a lone value was awarded an uncontested
  // "✓ BEST" pill — a false competitive claim. Mirrors v2's rankBadges guard.
  if (populated.length < 2) return [];
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
 * S289 KILL SWITCH (Andrew) — variant rows are new display behavior on a live
 * surface; flipping this to false restores per-slug rows (one row per
 * service, DEFAULT variant preferred — deterministic, unlike the pre-S289
 * last-write-wins) without touching the rest of Phase B (shared phrasing
 * engine, catalog names, ordering). Deploy-gated constant, not a runtime
 * flag, by choice: a feature_flag_rules row would cost a migration + client
 * flag plumbing during launch week.
 */
export const COMPARE_VARIANT_ROWS = true;

/**
 * S289 — variant title scheme (Andrew-approved structure): the service, the
 * COVERAGE COMPONENT as a "fees" suffix (facility fees / professional fees;
 * billing-grounded — global component adds nothing), then place-of-service
 * and drug-tier detail after an em-dash:
 *   "Surgery facility fees — independent facility"
 *   "Surgery professional fees"                     (place = any)
 *   "Generic Drugs — retail pharmacy · tier 1"      (global component)
 * Exported for the fixture.
 */
export function variantTitleParts(b: CompareBenefit): { feeType: string; tail: string } {
  const component = b.component ?? "global";
  const pos = b.placeOfService ?? "any";
  const tier = b.planTierLabel ?? "none";
  const feeType =
    component === "facility"
      ? "facility fees"
      : component === "professional"
        ? "professional fees"
        : "";
  const posLabel =
    pos === "any" ? "" : pos === "pcp_office" ? "PCP office" : pos.replace(/_/g, " ");
  const tierLabel = tier === "none" ? "" : tier.replace(/_/g, " ");
  const tail = [posLabel, tierLabel].filter(Boolean).join(" · ");
  return { feeType, tail };
}

export function variantQualifiedTitle(base: string, b: CompareBenefit): string {
  const { feeType, tail } = variantTitleParts(b);
  return `${base}${feeType ? ` ${feeType}` : ""}${tail ? ` — ${tail}` : ""}`;
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
  opts?: { variantRows?: boolean },
): CategoryGroup[] {
  const variantRows = opts?.variantRows ?? COMPARE_VARIANT_ROWS;
  const byCategory = new Map<
    string,
    Map<
      string,
      {
        serviceSlug: string;
        title: string;
        qualified: string;
        perPlan: Array<CompareBenefit[]>;
      }
    >
  >();
  const variantsPerSlug = new Map<string, Set<string>>();
  for (let planIdx = 0; planIdx < plans.length; planIdx++) {
    for (const benefit of plans[planIdx].benefits) {
      const category = benefit.category || "other";
      const slug = benefit.serviceSlug;
      if (!slug) continue;
      const key = variantRows ? variantKeyOf(benefit) : slug;
      (variantsPerSlug.get(slug) ?? variantsPerSlug.set(slug, new Set()).get(slug)!).add(
        variantKeyOf(benefit),
      );
      if (!byCategory.has(category)) byCategory.set(category, new Map());
      const rowMap = byCategory.get(category)!;
      if (!rowMap.has(key)) {
        rowMap.set(key, {
          serviceSlug: slug,
          title: benefit.title,
          qualified: variantQualifiedTitle(benefit.title, benefit),
          perPlan: Array.from({ length: plans.length }, () => []),
        });
      }
      rowMap.get(key)!.perPlan[planIdx].push(benefit);
    }
  }

  const groups: CategoryGroup[] = [];
  for (const [category, rowMap] of byCategory) {
    const rows: Array<ServiceRowAcrossPlans & { baseTitle: string }> = [];
    for (const [variantKey, { serviceSlug, title, qualified, perPlan }] of rowMap) {
      const multiVariant = (variantsPerSlug.get(serviceSlug)?.size ?? 1) > 1;
      rows.push({
        serviceSlug,
        variantKey,
        baseTitle: title,
        // Variant rows: qualify only when the slug genuinely has siblings.
        // Kill-switch mode: always the clean base title.
        title: variantRows && multiVariant ? qualified : title,
        // Variant-keyed cells hold ≤1 candidate by construction; slug-keyed
        // (kill-switch) cells hold every variant — the DEFAULT variant
        // represents (deterministic; better than the pre-S289 last-write-wins).
        perPlan: perPlan.map((candidates) => pickRepresentativeVariant(candidates)),
      });
    }
    // S289 review F8 — primary sort on the UNQUALIFIED title so a service's
    // variant rows stay contiguous (qualified-title collation could interleave
    // an unrelated same-prefix service between them), then variantKey.
    rows.sort(
      (a, b) =>
        a.baseTitle.localeCompare(b.baseTitle) || a.variantKey.localeCompare(b.variantKey),
    );
    groups.push({
      category,
      rows: rows.map((r) => ({
        serviceSlug: r.serviceSlug,
        variantKey: r.variantKey,
        title: r.title,
        perPlan: r.perPlan,
      })),
    });
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
  // S289 review F2 — wins count at SLUG level, best-variant per slug. Counting
  // variant rows let a plan rack up "Lowest cost on N services" from
  // uncontested single-populated rows and weighted a 3-variant service 3×.
  // Per slug: take each plan's own cheapest populated variant, then rank
  // plans on that (competition guard inside bestNumericIndices).
  const wins = new Array(planCount).fill(0);
  const bySlug = new Map<string, ServiceRowAcrossPlans[]>();
  for (const row of rows) {
    (bySlug.get(row.serviceSlug) ?? bySlug.set(row.serviceSlug, []).get(row.serviceSlug)!).push(row);
  }
  for (const slugRows of bySlug.values()) {
    const perPlanBest: Array<number | null> = new Array(planCount).fill(null);
    for (const row of slugRows) {
      for (let i = 0; i < planCount; i++) {
        const v = row.perPlan[i] ? inNetworkCopay(row.perPlan[i]) : null;
        if (v != null && (perPlanBest[i] == null || v < perPlanBest[i]!)) perPlanBest[i] = v;
      }
    }
    const bestIdx = bestNumericIndices(perPlanBest, (v) => v, true);
    for (const i of bestIdx) wins[i] += 1;
  }
  return wins;
}

/**
 * Per-plan covered count in a category. S289 review F2 — counts distinct
 * SLUGS (a plan covering Surgery in one global row vs a peer itemizing 3
 * variants both count 1), so the "N/M covered" summary measures coverage,
 * not extraction granularity. Denominator = distinctServiceCount(rows).
 */
export function coveredPerPlanInCategory(
  rows: ServiceRowAcrossPlans[],
  planCount: number,
): number[] {
  const covered = new Array(planCount).fill(0);
  const seen: Array<Set<string>> = Array.from({ length: planCount }, () => new Set());
  for (const row of rows) {
    for (let i = 0; i < planCount; i++) {
      const b = row.perPlan[i];
      if (b && b.covered !== false && !seen[i].has(row.serviceSlug)) {
        seen[i].add(row.serviceSlug);
        covered[i] += 1;
      }
    }
  }
  return covered;
}

/** S289 review F6 — distinct services (slugs) in a row set; the header/hint
 * count ("Surgery — N services"), NOT the variant-row count. */
export function distinctServiceCount(rows: ServiceRowAcrossPlans[]): number {
  return new Set(rows.map((r) => r.serviceSlug)).size;
}
