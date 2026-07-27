/**
 * S70 — Benefits Comparison library.
 *
 * Pure functions that normalize a canonical_plan_id OR insurance_plan_id into
 * a `ComparePlanPayload` shape consumable by the /compare page. Re-uses Phase
 * 4.0 decoration when the consumer_read_filter_v1 flag is ON; falls back to
 * raw values when OFF.
 *
 * Per Q-S70-3 LOCK A — endpoint accepts a 2-3 length array of mixed planRefs
 * (canonical OR user_plan); each ref is resolved independently.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCatalogIdentity } from "@/lib/plan/catalog-identity";
import { decorateFieldFromEntry } from "@/lib/parser/consumer-read";
import type { FieldProvenanceEntry } from "@/lib/parser/field-categories";
import type { DecorationContext } from "@/lib/plan/analyze-decoration";
import type { BestForTag } from "@/lib/plan/best-for";
import { formatInNetworkCost, formatOutOfNetworkCost } from "@/lib/plan/cost-share-format";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import {
  resolveSecondaryCoverage,
  loadBillSlugMeta,
  loadPlanCoverageMeta,
  loadCanonicalCoverageMeta,
  loadSecondaryGate,
  type BillSlugMeta,
  type CoveredSlugMeta,
  type SecondaryCoverage,
  type SecondaryMatchGate,
} from "@/lib/audit/coverage-loader";

export type PlanRef =
  | { kind: "canonical"; id: string }
  | { kind: "user_plan"; id: string };

export interface CompareBenefit {
  serviceSlug: string;
  category: string;
  title: string;
  /**
   * S289 Phase B — Pattern-S variant modifiers (defaults any/global/none).
   * The aggregates layer keys rows on (slug + these three) so multi-variant
   * services render one row PER VARIANT; before, a per-slug map made the
   * LAST variant win — nondeterministically, since the feeding queries had
   * no ORDER BY. Optional: synthesized benefits (backstop) omit them.
   */
  placeOfService?: string | null;
  component?: string | null;
  planTierLabel?: string | null;
  /** Cost summary string for display ("$30 copay" etc.). */
  costInNetworkDescription: string;
  costOutOfNetworkDescription: string;
  /** Decorated cost-sharing for state-badge rendering when flag ON. */
  costSharing: {
    inNetwork: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      copay: any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      coinsurance: any;
      deductibleApplies: boolean | null;
    };
    outOfNetwork: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      copay: any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      coinsurance: any;
      deductibleApplies: boolean | null;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    annualLimit: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    priorAuthRequired: any;
  };
  covered: boolean | null;
  /**
   * S161 (#1/#3) — present ONLY on a synthesized gap-fill benefit: this plan has
   * no enumerated row for the service, but coverage was inferred from a
   * same-category covered sibling (`preventive_care` → `annual_physical`) or the
   * ACA-preventive $0 statutory floor. Display surfaces badge it as an estimate
   * (Display State v5 `estimate`; never "verified") and exclude it from
   * competitive verdicts. Read-time inference only — never persisted.
   */
  inferred?: CompareCoverageInference | null;
}

/** S161 (#1/#3) — how a synthesized compare benefit's coverage was inferred.
 *  A3 (cite-grade gate): `synonym_cache` generalizes this to the IDENTITY axis — the row is real
 *  and enumerated, but its slug was assigned by an unconfirmed synonym cache-win (resolution_source
 *  set). The display already badges `inferred` as `estimate` and drops it from competitive verdicts
 *  (`attachBestForTags`), giving /compare parity with the /plan min() cap with no new FE work. */
export interface CompareCoverageInference {
  source: "secondary_match" | "aca_preventive" | "synonym_cache";
  /** Covered sibling slug coverage was borrowed from (secondary_match); the remapped slug itself
   *  (synonym_cache); null for the ACA $0 floor. */
  matchedSlug: string | null;
}

export interface ComparePlanSummary {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  premiumMonthly: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inDeductible: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  outDeductible: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inOopMax: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  outOopMax: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  planType: any;
  metalLevel: string | null;
  state: string | null;
  year: number | null;
  // PR4 (Compare v2) — paycheck-share + family ceilings for the premium model +
  // Yearly Lens. Raw math inputs (undecorated); premium-model / yearly-model read
  // them as OPTIONAL, so pre-PR4 callers stay correct. Canonical plans have no
  // paycheck split → employee/subsidy/frequency are null there.
  premiumEmployee: number | null;
  premiumSubsidy: number | null;
  premiumFrequency: string | null;
  inDeductibleFamily: number | null;
  inOopMaxFamily: number | null;
}

export interface ComparePlanPayload {
  /** Original ref echoed back so client can match column→ref. */
  ref: PlanRef;
  /** Canonical plan UUID when available (for both kinds — user plans resolve to their canonical). */
  canonicalPlanId: string | null;
  /** Display name shown in the column header. */
  planName: string;
  insurerName: string;
  planSummary: ComparePlanSummary;
  benefits: CompareBenefit[];
  /** Total covered services count for the breadth row. */
  coveredServiceCount: number;
  /** Source label — "canonical" / "user_plan" — for the "Your Plan" badge. */
  sourceLabel: "canonical" | "user_plan";
  /** Owned by this user (for user_plan kind only) — used as defense check. */
  isOwnedByUser: boolean;
  /** B3.3 — distinct verified users corroborating the canonical plan; sourced
   *  from canonical_plans.verification_count. For user_plan refs, looked up via
   *  plan.canonical_plan_id. Null when the user plan has no canonical link.
   *  Frontend buckets to power-of-10 floor for display per Pattern 1 #11. */
  corroborationCount: number | null;
  /** S70.A — top "Best for…" tags computed across the comparison cohort.
   *  Populated by attachBestForTags() after all plans resolve. */
  bestForTags?: BestForTag[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getProv(row: any, key: string): FieldProvenanceEntry | undefined {
  const fp = row?.field_provenance;
  if (!fp || typeof fp !== "object") return undefined;
  const entry = (fp as Record<string, unknown>)[key];
  return entry as FieldProvenanceEntry | undefined;
}

/** A3 (cite-grade gate): true iff this row's identity was assigned by an unconfirmed synonym
 *  cache-win (resolution_source on its coverage cells, identity_confirmed not yet set) and the
 *  flag is ON. The whole row shares one resolution_source (its slug was remapped), so the primary
 *  coverage cell is representative. Drives the `inferred: synonym_cache` marker → estimate badge +
 *  verdict-exclusion, parity with the /plan min() cap. */
function isSynonymInferred(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  row: any,
  decoration: DecorationContext | null,
): boolean {
  if (!decoration?.citeGradeGateOn) return false;
  const entry = getProv(row, "in_copay") ?? getProv(row, "in_coinsurance");
  return entry?.resolution_source != null && entry?.identity_confirmed !== true;
}

function maybeDecorate<T>(
  value: T,
  entry: FieldProvenanceEntry | undefined,
  source: string,
  sourceCount: number,
  decoration: DecorationContext | null,
): T | ReturnType<typeof decorateFieldFromEntry<T>> {
  if (!decoration) return value;
  return decorateFieldFromEntry(value, entry, {
    sourceCount,
    source,
    multiSourceThreshold: decoration.multiSourceThreshold,
    identityGateOn: decoration.citeGradeGateOn,
  });
}

// S289 Phase B — cost phrasing now comes from the shared, fixture-asserted
// module (src/lib/plan/cost-share-format.ts), the same engine /plan's analyze
// route uses. The former local describeCost/describeOonCost twins are gone:
// duplicated phrasing engines are the bug-class that produced the leg-③
// blank-cells defect. Call-site semantics preserved: covered:false →
// "Not covered"; extracted prose wins; OON's final fallback stays "—" here
// (compare cells render the string raw, unlike /plan which draws its own
// em-dash for "").

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function compareInCost(s: any): string {
  if (s.covered === false) return "Not covered";
  const prose = typeof s.in_cost_description === "string" ? s.in_cost_description.trim() : "";
  return prose || formatInNetworkCost(s);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function compareOonCost(s: any, planType: string | null): string {
  if (s.covered === false) return "Not covered";
  return formatOutOfNetworkCost(s, planType) || "—";
}

/**
 * S289 (Andrew) — "Services covered" is a MACRO count: distinct services
 * (slugs) with at least one covered benefit. The old
 * `benefits.filter(covered !== false).length` counted VARIANT benefits —
 * one per DB row — so a 3-variant surgery inflated the breadth number to 3.
 * (Pre-existing: payloads always carried per-variant benefits; the S289
 * nested display made the inflation visible.) Exported for the fixture.
 */
export function countCoveredServices(
  benefits: ReadonlyArray<{ serviceSlug: string; covered: boolean | null }>,
): number {
  const slugs = new Set<string>();
  for (const b of benefits) {
    if (b.serviceSlug && b.covered !== false) slugs.add(b.serviceSlug);
  }
  return slugs.size;
}

/**
 * S289 review F5 — deterministic representative among a slug's variant
 * benefits: the DEFAULT variant (any/global/none) when present — it means
 * "the service overall" — else the lowest variant key. Consumers that need
 * ONE benefit per slug (yearly lens rules, best-for copy) use this instead
 * of first/last-in-array, which .order("id") made deterministic but still
 * arbitrary (surgery facility 40% vs professional 50% — whichever row id
 * sorts first).
 */
export function pickRepresentativeVariant(candidates: CompareBenefit[]): CompareBenefit | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const keyOf = (b: CompareBenefit) =>
    `${b.placeOfService ?? "any"}|${b.component ?? "global"}|${b.planTierLabel ?? "none"}`;
  const dflt = candidates.find((b) => keyOf(b) === "any|global|none");
  if (dflt) return dflt;
  return [...candidates].sort((a, b) => keyOf(a).localeCompare(keyOf(b)))[0];
}

function titleCase(slug: string | null | undefined): string {
  if (!slug) return "—";
  return slug
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Resolvers ──────────────────────────────────────────────────────────────

/**
 * Resolve a canonical plan to a ComparePlanPayload. Reads canonical_plans +
 * canonical_plan_services + insurer_catalog. Per CF-19c (mig 071), canonical_plan_services
 * carries OON columns (out_copay, out_coinsurance, out_deductible_applies).
 */
export async function resolveCanonicalPlan(opts: {
  supabase: SupabaseClient;
  canonicalPlanId: string;
  decoration: DecorationContext | null;
}): Promise<ComparePlanPayload | null> {
  const { supabase, canonicalPlanId, decoration } = opts;

  const { data: plan, error } = await supabase
    .from("canonical_plans")
    .select(
      "id, insurer_id, plan_name, plan_type, state, plan_year, metal_level, deductible_individual, oop_max_individual, deductible_family, oop_max_family, premium_monthly, field_provenance, verification_count",
    )
    .eq("id", canonicalPlanId)
    .single();

  if (error || !plan) return null;

  let insurerName = "";
  if (plan.insurer_id) {
    const { data: insurer } = await supabase
      .from("insurer_catalog")
      .select("name")
      .eq("id", plan.insurer_id)
      .single();
    insurerName = insurer?.name ?? "";
  }

  const { data: services } = await supabase
    .from("canonical_plan_services")
    .select("*")
    .eq("canonical_plan_id", canonicalPlanId)
    // S289 Phase B — deterministic row order. Without it, which variant of a
    // multi-variant slug displayed was Postgres heap order (could change
    // after a VACUUM). The aggregates layer also sorts; this makes the raw
    // payload stable too.
    .order("id");

  // B3.3 — enrich each service with category from service_catalog.
  // canonical_plan_services has service_slug TEXT (no inline-join FK until
  // mig 213); S289 swapped the former inline two-query merge for the shared
  // merge-chain resolver so /compare, /plan gap-fill, and the audit
  // coverage-loader give one answer for the same stored slug.
  const catalogIdentity = await loadCatalogIdentity(
    supabase,
    (services ?? []).map((s) => s.service_slug as string | null),
  );

  const sourceCount = decoration?.canonicalSourceCount ?? plan.verification_count ?? 1;
  const logicalSource = "canonical_inherited";

  const benefits: CompareBenefit[] = (services ?? [])
    .filter((s) => s.service_slug)
    .map((s) => {
      const slug = s.service_slug as string;
      // canonical_plan_services has no in_/out_cost_description columns (those are
      // SBC-parser-only on plan_covered_services). Cost summaries assemble from
      // structured copay/coinsurance/deductible fields exclusively.
      return {
        // S289 review F4 — emit the LIVE slug: a canonical row stored on a
        // merged (dead) slug otherwise splits from the user-plan row of the
        // same service into two identically-TITLED rows (titles already
        // resolve live) with complementary empty cells. Read-only surface —
        // no write path receives this remap.
        serviceSlug: catalogIdentity.get(slug)?.liveSlug ?? slug,
        // A3: synonym-inferred identity → estimate + drop from verdicts (parity with the /plan cap).
        inferred: isSynonymInferred(s, decoration)
          ? { source: "synonym_cache" as const, matchedSlug: slug }
          : null,
        category: catalogIdentity.get(slug)?.category ?? "other",
        // S289 Phase B — display name from the live catalog row (parity with
        // /plan and with this file's own user-plan path below); the slug
        // prettify made the SAME plan read "Pcp Visit" here and "Primary Care
        // Visit" on /plan.
        title: catalogIdentity.get(slug)?.name ?? titleCase(slug),
        costInNetworkDescription: compareInCost(s),
        costOutOfNetworkDescription: compareOonCost(s, plan.plan_type ?? null),
        // S289 Phase B — variant identity (Pattern S modifiers) so the
        // aggregates layer can render one row PER VARIANT instead of
        // last-write-wins per slug.
        placeOfService: (s.place_of_service as string | null) ?? "any",
        component: (s.component as string | null) ?? "global",
        planTierLabel: (s.plan_tier_label as string | null) ?? "none",
        costSharing: {
          inNetwork: {
            copay: maybeDecorate<number | null>(
              s.covered === false ? null : s.in_copay ?? null,
              getProv(s, "in_copay"),
              logicalSource,
              sourceCount,
              decoration,
            ),
            coinsurance: maybeDecorate<number | null>(
              s.covered === false ? null : s.in_coinsurance ?? null,
              getProv(s, "in_coinsurance"),
              logicalSource,
              sourceCount,
              decoration,
            ),
            deductibleApplies: s.covered === false ? false : s.in_deductible_applies ?? null,
          },
          outOfNetwork: {
            copay: maybeDecorate<number | null>(
              s.covered === false ? null : s.out_copay ?? null,
              getProv(s, "out_copay"),
              logicalSource,
              sourceCount,
              decoration,
            ),
            coinsurance: maybeDecorate<number | null>(
              s.covered === false ? null : s.out_coinsurance ?? null,
              getProv(s, "out_coinsurance"),
              logicalSource,
              sourceCount,
              decoration,
            ),
            deductibleApplies: s.covered === false ? false : s.out_deductible_applies ?? null,
          },
          annualLimit: maybeDecorate<string | null>(
            s.annual_limit ? String(s.annual_limit) : null,
            getProv(s, "annual_limit"),
            logicalSource,
            sourceCount,
            decoration,
          ),
          priorAuthRequired: maybeDecorate<boolean | null>(
            s.prior_auth_required ?? null,
            getProv(s, "prior_auth_required"),
            logicalSource,
            sourceCount,
            decoration,
          ),
        },
        covered: s.covered ?? null,
      };
    });

  return {
    ref: { kind: "canonical", id: canonicalPlanId },
    canonicalPlanId,
    planName: plan.plan_name,
    insurerName,
    planSummary: {
      premiumMonthly: maybeDecorate<number | null>(
        plan.premium_monthly,
        getProv(plan, "premium_monthly"),
        logicalSource,
        sourceCount,
        decoration,
      ),
      inDeductible: maybeDecorate<number | null>(
        plan.deductible_individual,
        getProv(plan, "deductible_individual"),
        logicalSource,
        sourceCount,
        decoration,
      ),
      outDeductible: maybeDecorate<number | null>(
        null,
        getProv(plan, "out_deductible_individual"),
        logicalSource,
        sourceCount,
        decoration,
      ),
      inOopMax: maybeDecorate<number | null>(
        plan.oop_max_individual,
        getProv(plan, "oop_max_individual"),
        logicalSource,
        sourceCount,
        decoration,
      ),
      outOopMax: maybeDecorate<number | null>(
        null,
        getProv(plan, "out_oop_max_individual"),
        logicalSource,
        sourceCount,
        decoration,
      ),
      planType: maybeDecorate<string | null>(
        plan.plan_type,
        getProv(plan, "plan_type"),
        logicalSource,
        sourceCount,
        decoration,
      ),
      metalLevel: plan.metal_level,
      state: plan.state,
      year: plan.plan_year,
      // Canonical = community aggregate; no paycheck split. Family ceilings come
      // from the canonical row when present (PR4 Yearly Lens household math).
      premiumEmployee: null,
      premiumSubsidy: null,
      premiumFrequency: null,
      inDeductibleFamily: (plan.deductible_family as number | null) ?? null,
      inOopMaxFamily: (plan.oop_max_family as number | null) ?? null,
    },
    benefits,
    coveredServiceCount: countCoveredServices(benefits),
    sourceLabel: "canonical",
    isOwnedByUser: false,
    corroborationCount: (plan.verification_count as number | null) ?? 0,
  };
}

/**
 * Resolve a user-owned insurance_plans row to a ComparePlanPayload. Reads
 * insurance_plans + plan_covered_services with service_catalog join.
 * Verifies the row is owned by the supplied internal_user_id (defense
 * against IDOR — the route layer also checks this; defense in depth).
 */
export async function resolveUserPlan(opts: {
  supabase: SupabaseClient;
  insurancePlanId: string;
  internalUserId: string;
  decoration: DecorationContext | null;
}): Promise<ComparePlanPayload | null> {
  const { supabase, insurancePlanId, internalUserId, decoration } = opts;

  const { data: plan, error } = await supabase
    .from("insurance_plans")
    .select("*")
    .eq("id", insurancePlanId)
    .single();

  if (error || !plan) return null;
  if (plan.user_id !== internalUserId) return null; // IDOR guard.

  let insurerName = (plan.insurer_name as string | null) ?? "";
  if (!insurerName && plan.insurer_id) {
    const { data: insurer } = await supabase
      .from("insurer_catalog")
      .select("name")
      .eq("id", plan.insurer_id)
      .single();
    insurerName = insurer?.name ?? "";
  }

  // B3.3 — corroboration count for user plans comes from the linked canonical
  // (when present). User plans don't carry their own count; they inherit from
  // canonical via Pattern 1 #3 (3+ distinct EMAIL+PHONE-verified users with
  // cite-grade extracts). Null when the user plan has no canonical link.
  let corroborationCount: number | null = null;
  const linkedCanonicalId = (plan.canonical_plan_id as string | null) ?? null;
  if (linkedCanonicalId) {
    const { data: canonical } = await supabase
      .from("canonical_plans")
      .select("verification_count")
      .eq("id", linkedCanonicalId)
      .single();
    corroborationCount = (canonical?.verification_count as number | null) ?? null;
  }

  const { data: services } = await supabase
    .from("plan_covered_services")
    .select("*, service_catalog!inner(slug, name, category, merged_into_id)")
    .eq("insurance_plan_id", insurancePlanId)
    .is("service_catalog.merged_into_id", null)
    // S289 Phase B — deterministic row order (see canonical resolver note).
    .order("id");

  const planSource = (plan.source as string) ?? "doc_extraction";

  const benefits: CompareBenefit[] = (services ?? []).map((s) => {
    const slug = s.service_catalog?.slug || "unknown";
    const rawName = s.service_catalog?.name || titleCase(slug);
    const isNotCovered = s.covered === false;
    return {
      serviceSlug: slug,
      // A3: synonym-inferred identity → estimate + drop from verdicts (parity with the /plan cap).
      inferred: isSynonymInferred(s, decoration)
        ? { source: "synonym_cache" as const, matchedSlug: slug }
        : null,
      category: s.service_catalog?.category || "other",
      title: rawName,
      costInNetworkDescription: compareInCost(s),
      costOutOfNetworkDescription: compareOonCost(s, (plan.plan_type as string | null) ?? null),
      // S289 Phase B — variant identity (see canonical path note above).
      placeOfService: (s.place_of_service as string | null) ?? "any",
      component: (s.component as string | null) ?? "global",
      planTierLabel: (s.plan_tier_label as string | null) ?? "none",
      costSharing: {
        inNetwork: {
          copay: maybeDecorate<number | null>(
            isNotCovered ? null : s.in_copay,
            getProv(s, "in_copay"),
            planSource,
            1,
            decoration,
          ),
          coinsurance: maybeDecorate<number | null>(
            isNotCovered ? null : s.in_coinsurance,
            getProv(s, "in_coinsurance"),
            planSource,
            1,
            decoration,
          ),
          deductibleApplies: isNotCovered ? false : s.in_deductible_applies ?? null,
        },
        outOfNetwork: {
          copay: maybeDecorate<number | null>(
            isNotCovered ? null : s.out_copay,
            getProv(s, "out_copay"),
            planSource,
            1,
            decoration,
          ),
          coinsurance: maybeDecorate<number | null>(
            isNotCovered ? null : s.out_coinsurance,
            getProv(s, "out_coinsurance"),
            planSource,
            1,
            decoration,
          ),
          deductibleApplies: isNotCovered ? false : s.out_deductible_applies ?? null,
        },
        annualLimit: maybeDecorate<string | null>(
          s.annual_limit ?? null,
          getProv(s, "annual_limit"),
          planSource,
          1,
          decoration,
        ),
        priorAuthRequired: maybeDecorate<boolean | null>(
          s.prior_auth_required ?? null,
          getProv(s, "prior_auth_required"),
          planSource,
          1,
          decoration,
        ),
      },
      covered: s.covered ?? null,
    };
  });

  return {
    ref: { kind: "user_plan", id: insurancePlanId },
    canonicalPlanId: (plan.canonical_plan_id as string | null) ?? null,
    planName: (plan.plan_name as string | null) ?? "Your plan",
    insurerName,
    planSummary: {
      premiumMonthly: maybeDecorate<number | null>(
        plan.premium_total ?? null,
        undefined,
        planSource,
        1,
        decoration,
      ),
      inDeductible: maybeDecorate<number | null>(
        plan.in_deductible_individual ?? null,
        getProv(plan, "in_deductible_individual"),
        planSource,
        1,
        decoration,
      ),
      outDeductible: maybeDecorate<number | null>(
        plan.out_deductible_individual ?? null,
        getProv(plan, "out_deductible_individual"),
        planSource,
        1,
        decoration,
      ),
      inOopMax: maybeDecorate<number | null>(
        plan.in_oop_max_individual ?? null,
        getProv(plan, "in_oop_max_individual"),
        planSource,
        1,
        decoration,
      ),
      outOopMax: maybeDecorate<number | null>(
        plan.out_oop_max_individual ?? null,
        getProv(plan, "out_oop_max_individual"),
        planSource,
        1,
        decoration,
      ),
      planType: maybeDecorate<string | null>(
        (plan.plan_type as string | null) ?? null,
        getProv(plan, "plan_type"),
        planSource,
        1,
        decoration,
      ),
      metalLevel: (plan.metal_level as string | null) ?? null,
      state: (plan.state as string | null) ?? null,
      year: (plan.plan_year as number | null) ?? null,
      // PR4 — real paycheck-share + family ceilings from the user's insurance_plans
      // row (premium-model prefers employee net subsidy; yearly-model uses family
      // ceilings for households >1).
      premiumEmployee: (plan.premium_employee as number | null) ?? null,
      premiumSubsidy: (plan.premium_subsidy as number | null) ?? null,
      premiumFrequency: (plan.premium_frequency as string | null) ?? null,
      inDeductibleFamily: (plan.in_deductible_family as number | null) ?? null,
      inOopMaxFamily: (plan.in_oop_max_family as number | null) ?? null,
    },
    benefits,
    coveredServiceCount: countCoveredServices(benefits),
    sourceLabel: "user_plan",
    isOwnedByUser: true,
    corroborationCount,
  };
}

// ============================================================================
// S161 (#1/#3) — /compare preventive secondary backstop
// ============================================================================
//
// The compare grid builds each service ROW from the UNION of slugs across the
// cohort; a plan that lacks a slug renders "Not listed yet" (unk) — even when it
// covers that preventive service under a sibling name (it lists `preventive_care`
// but not `annual_physical`) or is ACA-mandated to cover it at $0. This ports the
// claims-path `resolveSecondaryCoverage` (same-category sibling → ACA $0 floor)
// to the compare surface so those cells read "covered" instead of falsely
// "not listed", extending the S154 "one shared resolver, can't drift" unification
// to a 4th surface.
//
// Scope is deliberately tight (Andrew, S161): ONLY preventive-eligible target
// slugs (the reported problem; preventive is reliably $0 / homogeneous) and ONLY
// the resolver's `confident` verdict — never a heterogeneous/uncertain borrow,
// which on a comparison grid would be a misleading cost (e.g. lending a PCP copay
// to a specialist cell). The claims path stays the place where estimate-confidence
// borrows + a Verify affordance live (there the user has a bill for the exact
// service). Read-time inference only — no writes; every synthesized cell is
// flagged `inferred` so the UI badges it as an estimate and drops it from
// competitive verdicts.

function buildInferredBenefit(
  slug: string,
  category: string | null,
  sec: SecondaryCoverage,
  // S289 review F3 — modifiers of the cohort's enumerated variant of this
  // slug, so the synthesized benefit lands in the EXISTING variant row.
  variant?: { placeOfService: string; component: string; planTierLabel: string },
): CompareBenefit {
  const cov = sec.coverage;
  return {
    serviceSlug: slug,
    category: category ?? "other",
    title: titleCase(slug),
    placeOfService: variant?.placeOfService ?? "any",
    component: variant?.component ?? "global",
    planTierLabel: variant?.planTierLabel ?? "none",
    costInNetworkDescription:
      cov.covered === false
        ? "Not covered"
        : formatInNetworkCost({
            in_copay: cov.copay ?? null,
            in_coinsurance: cov.coinsurance ?? null,
            // Preventive sibling / ACA coverage is not deductible-gated, and
            // the borrowed coverage carries no deductible signal either way.
            in_deductible_applies: false,
          }),
    // OON is never inferred — it stays unk/na honestly (compare_v2 §6 item 2).
    costOutOfNetworkDescription: "—",
    costSharing: {
      inNetwork: {
        copay: cov.copay ?? null,
        coinsurance: cov.coinsurance ?? null,
        deductibleApplies: false,
      },
      outOfNetwork: { copay: null, coinsurance: null, deductibleApplies: null },
      annualLimit: null,
      priorAuthRequired: null,
    },
    covered: true,
    inferred: { source: sec.source, matchedSlug: sec.matchedSlug },
  };
}

/**
 * Pure core of the compare backstop (no DB / no flag) so it is unit-testable.
 * Mutates each payload's `benefits` in place, appending one synthesized inferred
 * benefit for every PREVENTIVE-eligible cohort-row slug the plan is missing that
 * resolves to a CONFIDENT secondary coverage.
 */
export function computeCompareBackstop(
  payloads: ComparePlanPayload[],
  ctx: {
    billMetaBySlug: Map<string, BillSlugMeta>;
    coverageByRefId: Map<
      string,
      { coveredMeta: CoveredSlugMeta[]; acaCompliant: boolean | null }
    >;
    gate: SecondaryMatchGate;
  },
): void {
  const unionSlugs = Array.from(
    new Set(payloads.flatMap((p) => p.benefits.map((b) => b.serviceSlug).filter(Boolean))),
  );
  if (unionSlugs.length === 0) return;
  // S289 review F3 — variant-aware synthesis: the grouping layer now keys rows
  // on (slug|pos|component|tier). A synthesized benefit at bare defaults
  // (any|global|none) would mint a NEW half-empty row beside the cohort's real
  // variant rows — each plan then shows a false "Not listed yet" cell for a
  // service it has, the exact S161 defect this backstop exists to kill. Copy
  // the modifiers of the cohort's first (deterministic) enumerated variant of
  // that slug so the inferred benefit lands IN the existing row.
  const cohortVariantBySlug = new Map<
    string,
    { placeOfService: string; component: string; planTierLabel: string }
  >();
  for (const p of payloads) {
    for (const b of p.benefits) {
      if (!b.serviceSlug || cohortVariantBySlug.has(b.serviceSlug)) continue;
      cohortVariantBySlug.set(b.serviceSlug, {
        placeOfService: b.placeOfService ?? "any",
        component: b.component ?? "global",
        planTierLabel: b.planTierLabel ?? "none",
      });
    }
  }
  for (const p of payloads) {
    const cov = ctx.coverageByRefId.get(p.ref.id);
    if (!cov) continue;
    const present = new Set(p.benefits.map((b) => b.serviceSlug));
    for (const slug of unionSlugs) {
      if (present.has(slug)) continue;
      const bm = ctx.billMetaBySlug.get(slug);
      // Preventive-only scope: the reported #1/#3 case, and the one category where
      // a same-category borrow is reliably correct ($0).
      if (!bm || !bm.isPreventiveEligible) continue;
      const sec = resolveSecondaryCoverage(slug, bm, cov.coveredMeta, cov.acaCompliant, ctx.gate);
      if (!sec || sec.confidence !== "confident") continue;
      p.benefits.push(
        buildInferredBenefit(slug, bm.category, sec, cohortVariantBySlug.get(slug)),
      );
      present.add(slug);
    }
  }
}

/**
 * S161 (#1/#3) — DB-backed wrapper: gated on `secondary_coverage_v2` (OFF →
 * no-op → byte-identical payload), loads the cohort's bill-slug metadata + each
 * plan's covered-sibling context (canonical via the metal→ACA proxy; user plans
 * via their own `is_aca_compliant`), then runs the pure backstop. Call AFTER the
 * best-for tags so they stay grounded in enumerated (non-inferred) coverage.
 */
export async function applyCompareSecondaryBackstop(
  supabase: SupabaseClient,
  payloads: ComparePlanPayload[],
): Promise<void> {
  if (payloads.length === 0) return;
  if (!(await isFeatureEnabled("secondary_coverage_v2"))) return;

  const unionSlugs = Array.from(
    new Set(payloads.flatMap((p) => p.benefits.map((b) => b.serviceSlug).filter(Boolean))),
  );
  if (unionSlugs.length === 0) return;

  const canonicalIds = payloads.filter((p) => p.ref.kind === "canonical").map((p) => p.ref.id);
  const userPlanIds = payloads.filter((p) => p.ref.kind === "user_plan").map((p) => p.ref.id);

  const [billMetaBySlug, gate, canonMeta, userMeta] = await Promise.all([
    loadBillSlugMeta(supabase, unionSlugs),
    loadSecondaryGate(supabase),
    loadCanonicalCoverageMeta(supabase, canonicalIds),
    loadPlanCoverageMeta(supabase, userPlanIds),
  ]);

  const coverageByRefId = new Map<
    string,
    { coveredMeta: CoveredSlugMeta[]; acaCompliant: boolean | null }
  >();
  for (const [id, m] of canonMeta) {
    coverageByRefId.set(id, { coveredMeta: m.coveredMeta, acaCompliant: m.acaCompliant });
  }
  for (const [id, m] of userMeta) {
    coverageByRefId.set(id, { coveredMeta: m.coveredMeta, acaCompliant: m.acaCompliant });
  }

  computeCompareBackstop(payloads, { billMetaBySlug, coverageByRefId, gate });
}
