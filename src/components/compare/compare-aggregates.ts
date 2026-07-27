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
  /**
   * S289 nested rows (Andrew) — the qualifier-only label a variant renders
   * with when nested under its service's parent row ("Facility Fees —
   * independent facility"; the umbrella variant reads "All settings").
   */
  subLabel: string;
  perPlan: Array<CompareBenefit | null>;
}

/** Per-plan service-level coverage status (parent-row chips). */
export type ServiceCoverageStatus = "covered" | "not_covered" | "not_listed";

/**
 * S289 nested rows (Andrew) — one entry per SERVICE: parent-row status per
 * plan + the variant rows nested under it. Single-variant services render
 * flat (multiVariant=false); the accordions iterate `services` for display
 * while the math helpers keep consuming the flat `rows`.
 */
export interface ServiceEntry {
  serviceSlug: string;
  title: string;
  multiVariant: boolean;
  perPlanStatus: ServiceCoverageStatus[];
  variants: ServiceRowAcrossPlans[];
}

export interface CategoryGroup {
  category: string;
  rows: ServiceRowAcrossPlans[];
  services: ServiceEntry[];
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
 * S289 — variant title scheme (Andrew): pre-dash = WHAT KIND of charge line
 * (component as a "fees" suffix; drug tier — a charge BUCKET, same axis);
 * post-dash = WHERE (place of service). Tier is plan-local vocabulary
 * (Pattern S), so drug variant rows often fill for one plan only — honest.
 *   "Surgery facility fees — independent facility"
 *   "Surgery professional fees"              (place = any)
 *   "Generic Drugs tier 1 — retail pharmacy" (tier is a bucket, not a place)
 * Exported for the fixture.
 */
export function variantTitleParts(b: CompareBenefit): { qualifier: string; tail: string } {
  const component = b.component ?? "global";
  const pos = b.placeOfService ?? "any";
  const tier = b.planTierLabel ?? "none";
  // Andrew S289: the pre-dash qualifier is Title Case ("Facility Fees",
  // "Tier 1"); the post-dash place stays lowercase (PCP excepted).
  const titleCaseWords = (s: string) =>
    s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const feeType =
    component === "facility"
      ? "Facility Fees"
      : component === "professional"
        ? "Professional Fees"
        : "";
  const tierLabel = tier === "none" ? "" : titleCaseWords(tier);
  const qualifier = [feeType, tierLabel].filter(Boolean).join(" ");
  const tail = pos === "any" ? "" : pos === "pcp_office" ? "PCP office" : pos.replace(/_/g, " ");
  return { qualifier, tail };
}

export function variantQualifiedTitle(base: string, b: CompareBenefit): string {
  const { qualifier, tail } = variantTitleParts(b);
  return `${base}${qualifier ? ` ${qualifier}` : ""}${tail ? ` — ${tail}` : ""}`;
}

/**
 * S289 nested rows (Andrew D2) — the label a variant sub-row renders with
 * under its parent service row: qualifier-only, never repeating the service
 * name. The umbrella variant (no modifiers) reads "All settings".
 */
export function variantRowLabel(b: CompareBenefit): string {
  const { qualifier, tail } = variantTitleParts(b);
  if (!qualifier && !tail) return "All settings";
  return `${qualifier}${qualifier && tail ? " — " : ""}${tail}`;
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
      const cells = perPlan.map((candidates) => pickRepresentativeVariant(candidates));
      const anyBenefit = cells.find((b) => b != null) ?? null;
      rows.push({
        serviceSlug,
        variantKey,
        baseTitle: title,
        // Variant rows: qualify only when the slug genuinely has siblings.
        // Kill-switch mode: always the clean base title.
        title: variantRows && multiVariant ? qualified : title,
        subLabel: anyBenefit ? variantRowLabel(anyBenefit) : "All settings",
        // Variant-keyed cells hold ≤1 candidate by construction; slug-keyed
        // (kill-switch) cells hold every variant — the DEFAULT variant
        // represents (deterministic; better than the pre-S289 last-write-wins).
        perPlan: cells,
      });
    }
    // S289 review F8 — primary sort on the UNQUALIFIED title so a service's
    // variant rows stay contiguous (qualified-title collation could interleave
    // an unrelated same-prefix service between them), then variantKey.
    rows.sort(
      (a, b) =>
        a.baseTitle.localeCompare(b.baseTitle) || a.variantKey.localeCompare(b.variantKey),
    );
    const flatRows: ServiceRowAcrossPlans[] = rows.map((r) => ({
      serviceSlug: r.serviceSlug,
      variantKey: r.variantKey,
      title: r.title,
      subLabel: r.subLabel,
      perPlan: r.perPlan,
    }));

    // S289 nested rows (Andrew) — service-level entries: parent status per
    // plan + nested variants. Rows are sorted; grouping by slug in row order
    // keeps entries and their variants in display order.
    const entryBySlug = new Map<string, ServiceEntry>();
    for (let i = 0; i < flatRows.length; i++) {
      const row = flatRows[i];
      let entry = entryBySlug.get(row.serviceSlug);
      if (!entry) {
        entry = {
          serviceSlug: row.serviceSlug,
          title: rows[i].baseTitle,
          multiVariant: false,
          perPlanStatus: [],
          variants: [],
        };
        entryBySlug.set(row.serviceSlug, entry);
      }
      entry.variants.push(row);
    }
    const planCount = plans.length;
    for (const entry of entryBySlug.values()) {
      entry.multiVariant = entry.variants.length > 1;
      entry.perPlanStatus = Array.from({ length: planCount }, (_, i) => {
        let sawListed = false;
        for (const v of entry.variants) {
          const b = v.perPlan[i];
          if (!b) continue;
          sawListed = true;
          if (b.covered !== false) return "covered" as const;
        }
        return sawListed ? ("not_covered" as const) : ("not_listed" as const);
      });
    }
    groups.push({ category, rows: flatRows, services: Array.from(entryBySlug.values()) });
  }
  return groups;
}

/**
 * S289 (Andrew) — "Variants covered": per plan, X of Y where Y = every
 * variant listed for each service across the WHOLE comparison and X = the
 * ones this plan covers. Two Andrew-locked rules:
 *   - BLANKET CREDIT: a plan covering a service as one umbrella row (no
 *     place/fee detail) covers ALL of that service's listed variants —
 *     less-granular data is never penalized.
 *   - EXPLICIT EXCLUSION beats the umbrella: a listed covered:false variant
 *     is subtracted from the blanket credit.
 * D1 (approved): the drug-tier axis is EXCLUDED from the universe — tier
 * labels are plan-local vocabulary (Pattern S; one plan's "tier 1" is
 * another's "preferred"), so tier gaps are naming noise, not coverage gaps.
 * Tiers still render as sub-rows.
 */
export function variantCoveragePerPlan(
  plans: ComparePlanPayload[],
): Array<{ covered: number; total: number }> {
  const axisKey = (b: CompareBenefit) =>
    `${b.placeOfService ?? "any"}|${b.component ?? "global"}`;
  const UMBRELLA = "any|global";
  const universe = new Map<string, Set<string>>();
  // Per plan: slug → axisKey → true when ANY benefit at that key is covered
  // (a key holding only covered:false rows records false = explicit exclusion).
  const listed: Array<Map<string, Map<string, boolean>>> = plans.map(() => new Map());
  for (let i = 0; i < plans.length; i++) {
    for (const b of plans[i].benefits) {
      const slug = b.serviceSlug;
      if (!slug) continue;
      const key = axisKey(b);
      (universe.get(slug) ?? universe.set(slug, new Set()).get(slug)!).add(key);
      const bySlug = listed[i].get(slug) ?? listed[i].set(slug, new Map()).get(slug)!;
      bySlug.set(key, (bySlug.get(key) ?? false) || b.covered !== false);
    }
  }
  return plans.map((_, i) => {
    let covered = 0;
    let total = 0;
    for (const [slug, keys] of universe) {
      total += keys.size;
      const mine = listed[i].get(slug);
      if (!mine) continue;
      if (mine.get(UMBRELLA) === true) {
        let credit = keys.size;
        for (const [, anyCovered] of mine) {
          if (!anyCovered) credit -= 1;
        }
        covered += credit;
      } else {
        for (const [, anyCovered] of mine) {
          if (anyCovered) covered += 1;
        }
      }
    }
    return { covered, total };
  });
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
  // S289 (Andrew) — a service (slug) yields AT MOST ONE win, decided by the
  // side-by-side rows users actually see: within the slug, tally per-variant
  // row wins (bestNumericIndices only ranks rows where ≥2 plans have values),
  // and the plan winning STRICTLY the most contested rows takes the service.
  // Row-win tie or zero contested rows → no winner claimed.
  //
  // Two rejected alternatives, for the record: counting every variant row
  // (pre-review) let uncontested rows mint wins and weighted a 3-variant
  // service 3×; comparing each plan's own CHEAPEST variant (first fix)
  // cherry-picked — it could crown a plan's virtual-visit price over another
  // plan's office price and call that winning "office visits". This tally is
  // derivable from the rendered row pills, so the summary never claims more
  // than the grid shows.
  const wins = new Array(planCount).fill(0);
  const bySlug = new Map<string, ServiceRowAcrossPlans[]>();
  for (const row of rows) {
    (bySlug.get(row.serviceSlug) ?? bySlug.set(row.serviceSlug, []).get(row.serviceSlug)!).push(row);
  }
  for (const slugRows of bySlug.values()) {
    const rowWins = new Array(planCount).fill(0);
    for (const row of slugRows) {
      for (const i of bestNumericIndices(row.perPlan, inNetworkCopay, true)) rowWins[i] += 1;
    }
    const max = Math.max(...rowWins);
    if (max === 0) continue;
    const leaders = rowWins.reduce<number[]>((acc, w, i) => (w === max ? [...acc, i] : acc), []);
    if (leaders.length === 1) wins[leaders[0]] += 1;
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
