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
import { decorateFieldFromEntry } from "@/lib/parser/consumer-read";
import type { FieldProvenanceEntry } from "@/lib/parser/field-categories";
import type { DecorationContext } from "@/lib/plan/analyze-decoration";
import type { BestForTag } from "@/lib/plan/best-for";
import { normalizeCoinsurancePct } from "@/lib/billing/coinsurance";

export type PlanRef =
  | { kind: "canonical"; id: string }
  | { kind: "user_plan"; id: string };

export interface CompareBenefit {
  serviceSlug: string;
  category: string;
  title: string;
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
  });
}

function describeCost(opts: {
  copay: number | null;
  coinsurance: number | null;
  deductibleApplies: boolean | null;
  description: string | null;
  covered: boolean | null;
}): string {
  if (opts.covered === false) return "Not covered";
  if (opts.description && opts.description.trim().length > 0) {
    return opts.description.trim();
  }
  const parts: string[] = [];
  if (opts.copay != null) parts.push(`$${opts.copay} copay`);
  if (opts.coinsurance != null && opts.coinsurance > 0) {
    parts.push(`${normalizeCoinsurancePct(opts.coinsurance)}% coinsurance`);
  }
  if (opts.deductibleApplies) parts.push("after deductible");
  if (parts.length === 0 && opts.copay === 0 && opts.coinsurance === 0) {
    return "No charge";
  }
  if (parts.length === 0) return "Covered";
  return parts.join(", ").replace(/^./, (c) => c.toUpperCase());
}

function describeOonCost(opts: {
  copay: number | null;
  coinsurance: number | null;
  deductibleApplies: boolean | null;
  description: string | null;
  covered: boolean | null;
  planType: string | null;
}): string {
  if (opts.covered === false) return "Not covered";
  if (opts.description && opts.description.trim().length > 0) {
    return opts.description.trim();
  }
  const parts: string[] = [];
  if (opts.copay != null) parts.push(`$${opts.copay} copay`);
  if (opts.coinsurance != null && opts.coinsurance > 0) {
    parts.push(`${normalizeCoinsurancePct(opts.coinsurance)}% coinsurance`);
  }
  if (opts.deductibleApplies) parts.push("after deductible");
  if (parts.length > 0) return parts.join(", ").replace(/^./, (c) => c.toUpperCase());
  if (opts.copay === 0 && opts.coinsurance === 0) return "No charge";
  // HMO/EPO typically don't cover OON.
  const pt = (opts.planType || "").toUpperCase();
  if (pt === "HMO" || pt === "EPO") return "Not covered";
  return "—";
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
      "id, insurer_id, plan_name, plan_type, state, plan_year, metal_level, deductible_individual, oop_max_individual, premium_monthly, field_provenance, verification_count",
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
    .eq("canonical_plan_id", canonicalPlanId);

  // B3.3 — enrich each service with category from service_catalog.
  // canonical_plan_services has service_slug TEXT but NO foreign key to
  // service_catalog (unlike plan_covered_services which has the FK + supports
  // Supabase's inline join syntax). Do a two-query merge: collect distinct
  // slugs, lookup categories, build slug→category map. Allows /compare to
  // group benefits by real category instead of collapsing all to "other".
  const slugList = Array.from(
    new Set((services ?? []).map((s) => s.service_slug as string | null).filter(Boolean) as string[]),
  );
  const categoryBySlug = new Map<string, string>();
  if (slugList.length > 0) {
    const { data: catalog } = await supabase
      .from("service_catalog")
      .select("slug, category")
      .in("slug", slugList);
    for (const row of catalog ?? []) {
      const s = row.slug as string | null;
      const c = row.category as string | null;
      if (s && c) categoryBySlug.set(s, c);
    }
  }

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
        serviceSlug: slug,
        category: categoryBySlug.get(slug) ?? "other",
        title: titleCase(slug),
        costInNetworkDescription: describeCost({
          copay: s.copay ?? null,
          coinsurance: s.coinsurance ?? null,
          deductibleApplies: s.deductible_applies ?? null,
          description: null,
          covered: s.is_covered ?? null,
        }),
        costOutOfNetworkDescription: describeOonCost({
          copay: s.out_copay ?? null,
          coinsurance: s.out_coinsurance ?? null,
          deductibleApplies: s.out_deductible_applies ?? null,
          description: null,
          covered: s.is_covered ?? null,
          planType: plan.plan_type ?? null,
        }),
        costSharing: {
          inNetwork: {
            copay: maybeDecorate<number | null>(
              s.is_covered === false ? null : s.copay ?? null,
              getProv(s, "copay"),
              logicalSource,
              sourceCount,
              decoration,
            ),
            coinsurance: maybeDecorate<number | null>(
              s.is_covered === false ? null : s.coinsurance ?? null,
              getProv(s, "coinsurance"),
              logicalSource,
              sourceCount,
              decoration,
            ),
            deductibleApplies: s.is_covered === false ? false : s.deductible_applies ?? null,
          },
          outOfNetwork: {
            copay: maybeDecorate<number | null>(
              s.is_covered === false ? null : s.out_copay ?? null,
              getProv(s, "out_copay"),
              logicalSource,
              sourceCount,
              decoration,
            ),
            coinsurance: maybeDecorate<number | null>(
              s.is_covered === false ? null : s.out_coinsurance ?? null,
              getProv(s, "out_coinsurance"),
              logicalSource,
              sourceCount,
              decoration,
            ),
            deductibleApplies: s.is_covered === false ? false : s.out_deductible_applies ?? null,
          },
          annualLimit: maybeDecorate<string | null>(
            s.annual_limit ? String(s.annual_limit) : null,
            getProv(s, "annual_limit"),
            logicalSource,
            sourceCount,
            decoration,
          ),
          priorAuthRequired: maybeDecorate<boolean | null>(
            s.requires_prior_auth ?? null,
            getProv(s, "requires_prior_auth"),
            logicalSource,
            sourceCount,
            decoration,
          ),
        },
        covered: s.is_covered ?? null,
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
    },
    benefits,
    coveredServiceCount: benefits.filter((b) => b.covered !== false).length,
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
    .is("service_catalog.merged_into_id", null);

  const planSource = (plan.source as string) ?? "doc_extraction";

  const benefits: CompareBenefit[] = (services ?? []).map((s) => {
    const slug = s.service_catalog?.slug || "unknown";
    const rawName = s.service_catalog?.name || titleCase(slug);
    const isNotCovered = s.covered === false;
    return {
      serviceSlug: slug,
      category: s.service_catalog?.category || "other",
      title: rawName,
      costInNetworkDescription: describeCost({
        copay: s.in_copay ?? null,
        coinsurance: s.in_coinsurance ?? null,
        deductibleApplies: s.in_deductible_applies ?? null,
        description: s.in_cost_description ?? null,
        covered: s.covered ?? null,
      }),
      costOutOfNetworkDescription: describeOonCost({
        copay: s.out_copay ?? null,
        coinsurance: s.out_coinsurance ?? null,
        deductibleApplies: s.out_deductible_applies ?? null,
        description: s.out_cost_description ?? null,
        covered: s.covered ?? null,
        planType: plan.plan_type as string | null,
      }),
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
    },
    benefits,
    coveredServiceCount: benefits.filter((b) => b.covered !== false).length,
    sourceLabel: "user_plan",
    isOwnedByUser: true,
    corroborationCount,
  };
}
