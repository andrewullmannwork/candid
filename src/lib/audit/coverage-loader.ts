/**
 * Plan-coverage lookup helper for the audit pipeline.
 *
 * Loads `plan_covered_services` for a given insurance plan and builds a
 * Map<service_slug, PlanCoverageInput> that rules consume to compute should_owe
 * (copay / coinsurance / deductible). Used by:
 *   • process-chunk first-audit (persist.ts caller)
 *   • reaudit.ts view-fetch re-audit (D7)
 *   • admin resolve-type re-classify path
 *   • disputes rerun-audit path
 *
 * Returns null when no plan id is provided (rules see "coverage unknown" and
 * default should_owe to 0 — conservative for recovery framing).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlanCoverageInput } from "../claims/recovery-math";
import type { ParsedBill } from "../billing/types";
import {
  buildAcaCoverageFallback,
  type AcaFallbackResult,
} from "./aca-coverage-fallback";
import { normalizeCoinsuranceForStorage } from "../billing/coinsurance";

export type PlanCoverageMap = Map<string, PlanCoverageInput>;

/**
 * S135 — ACA-mandate override capture.
 *
 * Populated by `resolveLineCoverage` when an ACA-compliant plan's
 * `plan_covered_services` row disagrees with the federal ACA mandate (either
 * the plan assigns a non-$0 cost-share OR explicitly excludes the service)
 * AND the line is an ACA-preventive or ACIP-vaccine code. ACA wins for
 * math + bill state; this struct preserves the original plan terms for two
 * downstream consumers:
 *
 *   1. UI green plan-says box renders an inline override line ("Plan says
 *      $20 copay, but federal law (ACA) requires $0 for this preventive
 *      service") so the user sees the conflict in one place.
 *
 *   2. Dispute letter generation (future backend session) — strong citation
 *      that the plan may be violating federal law as an ACA-compliant plan.
 *      The dispute pipeline can call `resolveLineCoverage` at letter-gen time
 *      to recompute the override (helper is pure + deterministic), so no
 *      persistent metadata field is required for this hook.
 */
export interface AcaOverride {
  /** Original plan copay (before ACA override). May be null when plan didn't have a copay field. */
  planCopay: number | null;
  /** Original plan coinsurance (decimal 0-1, before ACA override). */
  planCoinsurance: number | null;
  /** Original plan covered status. `false` = plan-excludes-mandate case; `true` (or null) = plan-contradicts-mandate. */
  planCovered: boolean | null;
  /** ACA mandate basis: 'ACA_preventive' | 'ACIP_vaccine'. */
  basis: string | null;
}

/**
 * S74.6 D2 §B — audit-side ACA fallback. Coverage indexed by line number for
 * uncategorized lines (no slug yet) that hit the ACA registry. Audit rules
 * prefer this map over slug-keyed lookups so F-13 missing_adjustment + F-14
 * insurance_underpayment see covered coverage on ACA-mandated vaccine lines
 * even when D4 hasn't bound a slug to the code.
 */
export type AcaFallbackLineCoverageMap = Map<number, PlanCoverageInput>;

export interface AuditAcaFallback {
  /**
   * Coverage for slug-keyed lookups. Slugs PRESENT in the plan's
   * plan_covered_services are NOT included here (registry only fires on plan
   * miss); callers should merge this into their existing planCoverage map
   * with plan rows winning on key conflict.
   */
  bySlug: PlanCoverageMap;
  /** Per-line coverage for uncategorized lines (slug=null). */
  byLineNumber: AcaFallbackLineCoverageMap;
}

const EMPTY_AUDIT_ACA: AuditAcaFallback = {
  bySlug: new Map(),
  byLineNumber: new Map(),
};

/**
 * S74.6 D2 — Read the plan's `is_aca_compliant` flag for audit rules that
 * want to apply ACA-mandated zero-cost-share fallback. Audit pipeline reads
 * this alongside `loadCoverageMapForPlan` to decide whether to call
 * `buildAcaCoverageFallback` for each bill being evaluated.
 *
 * Returns null when planId is null/missing OR the column isn't populated
 * (legacy pre-mig-093 rows). Audit consumers treat null as "unknown ACA status"
 * → don't apply fallback (conservative: don't synthesize coverage based on
 * an assumption the parser didn't confirm).
 */
export async function loadAcaCompliantFlagForPlan(
  supabase: SupabaseClient,
  insurancePlanId: string | null | undefined,
): Promise<boolean | null> {
  if (!insurancePlanId) return null;
  const { data, error } = await supabase
    .from("insurance_plans")
    .select("is_aca_compliant")
    .eq("id", insurancePlanId)
    .maybeSingle();
  if (error) {
    console.warn("[coverage-loader] aca flag load failed", error);
    return null;
  }
  if (!data) return null;
  return (data.is_aca_compliant as boolean | null) ?? null;
}

/**
 * Thin audit-pipeline wrapper around `buildAcaCoverageFallback`. Converts a
 * `ParsedBill` into the line-item shape the helper expects and returns the
 * resulting bySlug + byLineNumber maps for audit-side merge. Callers MUST
 * have already loaded `planCoverage` so we can filter out lines whose slug
 * is already covered by the plan (registry only fires on plan miss).
 *
 * Returns empty maps when planId/userId missing or plan is not ACA-compliant
 * (mirrors `buildAcaCoverageFallback`'s gate behavior).
 */
export async function loadAcaFallbackForAudit(opts: {
  supabase: SupabaseClient;
  planId: string | null | undefined;
  userId: string | null | undefined;
  patientName: string | null | undefined;
  bill: ParsedBill;
  existingCoverageBySlug: ReadonlySet<string>;
}): Promise<AuditAcaFallback> {
  if (!opts.planId || !opts.userId) return EMPTY_AUDIT_ACA;
  const fallback = await buildAcaCoverageFallback({
    supabase: opts.supabase,
    planId: opts.planId,
    userId: opts.userId,
    patientName: opts.patientName,
    lineItems: opts.bill.lineItems.map((li) => ({
      lineNumber: li.lineNumber,
      procedureCode: li.procedureCode ?? null,
      // BillLineItem doesn't carry a code-type; let the fallback helper infer
      // via inferProcedureCodeType.
      procedureCodeType: null,
      // BillLineItem.category mirrors claim_line_items.service_slug after
      // persist runs the categorization flywheel (S74.5 D6 wiring).
      serviceSlug: li.category ?? null,
    })),
    existingCoverageBySlug: opts.existingCoverageBySlug,
  });
  return {
    bySlug: fallback.bySlug,
    byLineNumber: fallback.byLineNumber,
  };
}

/**
 * S135 — Per-line coverage resolution implementing the 4-state ACA matrix.
 *
 * State 1 (plan + ACA both say $0 cost-share):    use plan, no override
 * State 2 (plan says non-$0, ACA says $0):         use ACA, override captured
 * State 2b (plan says NOT COVERED, ACA says $0):   use ACA, override captured
 * State 3 (plan missing slug, ACA mandate applies): use ACA, no override (no plan to override)
 * State 4 (ACA mandate doesn't apply):             use plan as-is
 *
 * Returns `{coverage, acaOverride}`. `coverage` drives shouldOwe math + bill
 * state. `acaOverride` is non-null only in States 2 and 2b — surfaces the
 * plan-vs-ACA conflict for inline UI rendering + dispute letter citation.
 */
export interface ResolvedLineCoverage {
  coverage: PlanCoverageInput | null;
  acaOverride: AcaOverride | null;
}

export function resolveLineCoverage(
  planCov: PlanCoverageInput | null,
  acaCov: PlanCoverageInput | null,
  planMeta: AcaFallbackResult["planMeta"] | null = null,
): ResolvedLineCoverage {
  // State 4 — ACA doesn't apply to this line/plan.
  if (!acaCov) return { coverage: planCov, acaOverride: null };
  // State 3 — plan has no row for this slug; ACA fallback is the only source.
  if (!planCov) return { coverage: acaCov, acaOverride: null };
  // Both planCov and acaCov exist — check for conflict.
  const planExcludes = planCov.covered === false;
  const planSaysZero =
    !planExcludes &&
    (planCov.copay == null || planCov.copay === 0) &&
    (planCov.coinsurance == null || planCov.coinsurance === 0);
  // State 1 — plan and ACA agree on $0; plan row wins (preserves source attribution).
  if (planSaysZero) return { coverage: planCov, acaOverride: null };
  // States 2 / 2b — conflict; ACA wins. Capture original plan terms for UI + dispute.
  return {
    coverage: acaCov,
    acaOverride: {
      planCopay: planCov.copay,
      planCoinsurance: planCov.coinsurance,
      planCovered: planCov.covered,
      basis: planMeta?.basis ?? null,
    },
  };
}

// ============================================================================
// S153 — Secondary (category) coverage match
// ============================================================================
//
// The bill matcher resolves a line to its most accurate slug (e.g.
// `annual_physical`), but the plan's `plan_covered_services` may list the
// coverage under a sibling concept (`preventive_care`) — so the exact-slug
// lookup misses and the line shows "Unknown" even though the plan clearly
// covers the service. `concept_ancestors` is not populated, so we use the
// `category` field (annual_physical / immunizations / preventive_care all =
// 'preventive'; pcp_visit / specialist_visit = 'office_visit') as the
// secondary-match key. Result is marked `secondary_match` so it's never
// presented as a direct plan hit (Pattern 1 #11 methodology honesty).

export interface CoveredSlugMeta {
  slug: string;
  category: string | null;
  coverage: PlanCoverageInput;
}

export interface BillSlugMeta {
  category: string | null;
  isPreventiveEligible: boolean;
}

export interface SecondaryCoverage {
  coverage: PlanCoverageInput;
  /** The covered sibling slug we matched to; null for the ACA-preventive backstop. */
  matchedSlug: string | null;
  source: "secondary_match" | "aca_preventive";
  /**
   * S154 — gate outcome. `confident` = assert covered with no user action
   * (statutory ACA rule, a cost-share-homogeneous category, or an unambiguous
   * trigram identity). `estimate` = a plausible covered sibling exists but the
   * borrowed cost-share is ambiguous (heterogeneous category + weak textual
   * match) → callers show "Covered (estimate)" + a Verify-coverage affordance
   * and demote it below cite-grade in disputes until the user confirms.
   */
  confidence: "confident" | "estimate";
}

/**
 * S154 — secondary-match confidence gate thresholds. Tunable via the
 * `secondary_coverage_v2` flag config JSONB (Ship Gate G6); these are the
 * code-side fallbacks.
 */
export interface SecondaryMatchGate {
  /** Min trigram similarity for an "unambiguous identity" confident match. */
  trigramFloor: number;
  /** Best candidate must beat the runner-up by at least this to be unambiguous. */
  trigramMargin: number;
  /** Max copay-$ / coinsurance-fraction spread for a category to count as homogeneous. */
  homogeneityTolerance: number;
}

export const DEFAULT_SECONDARY_GATE: SecondaryMatchGate = {
  trigramFloor: 0.5,
  trigramMargin: 0.15,
  homogeneityTolerance: 0.01,
};

/**
 * S154 — load the gate thresholds from the `secondary_coverage_v2` flag config
 * JSONB (Ship Gate G6 — tunable with no deploy), per-field fallback to
 * DEFAULT_SECONDARY_GATE. Tune in PROD via:
 *   UPDATE feature_flag_rules
 *     SET config = jsonb_set(config, '{trigramFloor}', '0.6')
 *     WHERE flag_key = 'secondary_coverage_v2';
 */
export async function loadSecondaryGate(
  supabase: SupabaseClient,
): Promise<SecondaryMatchGate> {
  const { data } = await supabase
    .from("feature_flag_rules")
    .select("config")
    .eq("flag_key", "secondary_coverage_v2")
    .maybeSingle();
  const cfg = (data?.config as Record<string, unknown> | null) ?? null;
  const num = (k: keyof SecondaryMatchGate) =>
    typeof cfg?.[k] === "number" ? (cfg[k] as number) : DEFAULT_SECONDARY_GATE[k];
  return {
    trigramFloor: num("trigramFloor"),
    trigramMargin: num("trigramMargin"),
    homogeneityTolerance: num("homogeneityTolerance"),
  };
}

// Pediatric-specific services must not absorb an adult line (or vice-versa).
const PEDIATRIC_RE = /child|baby|pediatric|well_child/i;

function triGrams(s: string): Set<string> {
  const n = `  ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()} `;
  const g = new Set<string>();
  for (let i = 0; i < n.length - 2; i++) g.add(n.slice(i, i + 3));
  return g;
}
function triSim(a: string, b: string): number {
  const ga = triGrams(a);
  const gb = triGrams(b);
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const x of ga) if (gb.has(x)) inter++;
  return inter / (ga.size + gb.size - inter);
}

/** S154 — all covered candidates agree on cost-share, so which sibling we
 * borrow is moot (e.g. an all-$0 preventive category). Copays compared in
 * dollars, coinsurance as a 0-1 fraction; nulls treated as 0. */
function candidatesHomogeneous(
  candidates: CoveredSlugMeta[],
  tol: number,
): boolean {
  if (candidates.length <= 1) return true;
  const copays = candidates.map((c) => c.coverage.copay ?? 0);
  const coins = candidates.map((c) => c.coverage.coinsurance ?? 0);
  const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
  return spread(copays) <= tol && spread(coins) <= tol;
}

/**
 * Resolve coverage for a bill slug that has NO direct `plan_covered_services`
 * row, via (1) a same-category covered sibling, then (2) an ACA-preventive
 * $0 backstop. Returns null when neither applies (→ caller shows "Unknown").
 *
 * S154 — every non-null result carries a `confidence`:
 *   • `confident` — assert covered, no user action: the ACA statutory rule, a
 *     cost-share-homogeneous category (borrow is unambiguous), or an
 *     unambiguous trigram identity (clear which sibling).
 *   • `estimate` — a plausible covered sibling exists but the borrowed
 *     cost-share is ambiguous (heterogeneous category + weak textual match).
 *     Caller still shows "Covered" (per Andrew S154: never regress an
 *     identified service to Unknown) but attaches a Verify-coverage affordance
 *     and demotes it below cite-grade in disputes until the user confirms.
 *
 * Pure + deterministic (no Haiku / no DB) so it runs safely in the hot
 * claim-GET path and is identical across audit + display + dispute paths.
 */
export function resolveSecondaryCoverage(
  billSlug: string,
  billMeta: BillSlugMeta,
  covered: CoveredSlugMeta[],
  planAcaCompliant: boolean | null,
  gate: SecondaryMatchGate = DEFAULT_SECONDARY_GATE,
): SecondaryCoverage | null {
  // 1 — same-category covered sibling (excl. pediatric unless the bill is pediatric).
  if (billMeta.category) {
    const billIsPediatric = PEDIATRIC_RE.test(billSlug);
    const candidates = covered.filter(
      (c) =>
        // S154 fix — a secondary match is a DIFFERENT covered sibling; never the
        // bill slug itself (a same-slug hit is an exact match, handled upstream).
        // Guards the dispute path where the exact-lookup source can differ from
        // the sibling source, which let a slug self-match (trigram 1.0).
        c.slug !== billSlug &&
        c.category === billMeta.category &&
        c.coverage.covered !== false &&
        (billIsPediatric || !PEDIATRIC_RE.test(c.slug)),
    );
    if (candidates.length > 0) {
      // Deterministic order: trigram desc, then slug asc. S154 — the prior
      // "most generous copay on tie" tiebreak was DROPPED; it biased toward the
      // cheapest sibling, which understates should-owe and inflates apparent
      // overcharges. Identity (trigram), not generosity, picks the sibling; the
      // gate below decides confident-vs-estimate.
      const scored = candidates
        .map((c) => ({
          c,
          t: triSim(billSlug.replace(/_/g, " "), c.slug.replace(/_/g, " ")),
        }))
        .sort((a, b) => b.t - a.t || a.c.slug.localeCompare(b.c.slug));
      const best = scored[0];
      const runnerUp = scored[1];
      // Confident when the borrow is unambiguous: either the whole category
      // agrees on cost-share (homogeneous → which sibling is moot) OR the best
      // candidate is a clear textual identity (≥ floor AND beats the runner-up
      // by the margin). Otherwise it's a plausible-but-uncertain estimate.
      const homogeneous = candidatesHomogeneous(candidates, gate.homogeneityTolerance);
      const strongIdentity =
        best.t >= gate.trigramFloor &&
        (!runnerUp || best.t - runnerUp.t >= gate.trigramMargin);
      return {
        coverage: best.c.coverage,
        matchedSlug: best.c.slug,
        source: "secondary_match",
        confidence: homogeneous || strongIdentity ? "confident" : "estimate",
      };
    }
  }
  // 2 — ACA-preventive $0 backstop. S154 — CONFIRMED-ACA ONLY: fires only when
  // is_aca_compliant === true. Unknown (null) or non-ACA (false) plans hard-
  // exclude this statutory assumption (Andrew S154 direction) — they get
  // coverage only from their own enumerated services via path 1 above.
  if (billMeta.isPreventiveEligible && planAcaCompliant === true) {
    return {
      coverage: { covered: true, copay: 0, coinsurance: 0 },
      matchedSlug: null,
      source: "aca_preventive",
      confidence: "confident",
    };
  }
  return null;
}

export async function loadCoverageMapForPlan(
  supabase: SupabaseClient,
  insurancePlanId: string | null | undefined,
): Promise<PlanCoverageMap | null> {
  if (!insurancePlanId) return null;
  const { data, error } = await supabase
    .from("plan_covered_services")
    .select("covered, in_copay, in_coinsurance, service_catalog!inner(slug)")
    .eq("insurance_plan_id", insurancePlanId);
  if (error) {
    console.warn("[coverage-loader] failed to load coverage for plan", insurancePlanId, error);
    return null;
  }
  const map: PlanCoverageMap = new Map();
  for (const row of data ?? []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const slug = (row.service_catalog as any)?.slug as string | undefined;
    if (!slug) continue;
    map.set(slug, {
      covered: row.covered as boolean | null,
      copay: row.in_copay as number | null,
      // S132 iter-11 — plan_covered_services.in_coinsurance holds either
      // integer percent (30) OR already-decimal (0.3); both mean 30% in
      // plan-document language. normalizeCoinsuranceForStorage handles both
      // formats uniformly. Prior to this, this loader read the raw value
      // expecting decimal — broke for rows the parser wrote as integer.
      coinsurance: normalizeCoinsuranceForStorage(row.in_coinsurance as number | null),
    });
  }
  return map;
}

// ============================================================================
// S154 — shared secondary-match context loaders
// ============================================================================
//
// The bill DETAIL GET, the claims LIST, the discrepancy engine, and the audit
// pipeline each independently resolved coverage; only DETAIL applied the S153
// secondary match, so the home/dashboard read "Unknown" while DETAIL read
// "Covered" for the same line. These loaders give every consumer ONE shape for
// the secondary-match inputs (covered-sibling metadata + bill-slug metadata +
// plan ACA flag) so the four surfaces resolve identically and can't drift.

export interface PlanCoverageMeta {
  /** slug → coverage with plan-row source attribution (exact-match lookup). */
  coverageMap: Map<string, PlanCoverageInput & { source: string | null }>;
  /** covered slugs with category, for the secondary (category) match scan. */
  coveredMeta: CoveredSlugMeta[];
  /** plan's ACA-compliance flag (null = unknown → ACA backstop hard-excluded). */
  acaCompliant: boolean | null;
}

/**
 * S154 — batched loader for secondary-match context across one or more plans.
 * Consolidates the queries the DETAIL GET ran inline (plan_covered_services +
 * category, is_aca_compliant) into one per-plan shape so LIST / discrepancy /
 * audit / detail share it. Two round-trips total regardless of plan count.
 */
export async function loadPlanCoverageMeta(
  supabase: SupabaseClient,
  planIds: Array<string | null | undefined>,
): Promise<Map<string, PlanCoverageMeta>> {
  const out = new Map<string, PlanCoverageMeta>();
  const ids = Array.from(new Set(planIds.filter((id): id is string => Boolean(id))));
  if (ids.length === 0) return out;
  for (const id of ids) {
    out.set(id, { coverageMap: new Map(), coveredMeta: [], acaCompliant: null });
  }

  const { data: covered, error } = await supabase
    .from("plan_covered_services")
    .select(
      "insurance_plan_id, covered, in_copay, in_coinsurance, source, service_catalog!inner(slug, category)",
    )
    .in("insurance_plan_id", ids);
  if (error) {
    console.warn("[coverage-loader] loadPlanCoverageMeta covered load failed", error);
  } else {
    for (const row of covered ?? []) {
      const planId = row.insurance_plan_id as string;
      const entry = out.get(planId);
      if (!entry) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sc = row.service_catalog as any;
      const slug = sc?.slug as string | undefined;
      if (!slug) continue;
      const coverage: PlanCoverageInput = {
        covered: row.covered as boolean | null,
        copay: row.in_copay as number | null,
        // S132 iter-11 — in_coinsurance may be integer-percent OR decimal; the
        // normalizer returns decimal 0-1 uniformly.
        coinsurance: normalizeCoinsuranceForStorage(row.in_coinsurance as number | null),
      };
      entry.coverageMap.set(slug, { ...coverage, source: (row.source as string | null) ?? null });
      entry.coveredMeta.push({ slug, category: (sc?.category as string | null) ?? null, coverage });
    }
  }

  const { data: plans } = await supabase
    .from("insurance_plans")
    .select("id, is_aca_compliant")
    .in("id", ids);
  for (const p of plans ?? []) {
    const entry = out.get(p.id as string);
    if (entry) entry.acaCompliant = (p.is_aca_compliant as boolean | null) ?? null;
  }
  return out;
}

/**
 * S161 (#1/#3) — canonical analog of `loadPlanCoverageMeta` for the /compare
 * preventive backstop. `canonical_plan_services` has no FK to `service_catalog`
 * (unlike `plan_covered_services`), so category comes from a second lookup.
 *
 * `canonical_plans` carries no `is_aca_compliant` column (that lives only on
 * `insurance_plans`, mig 093) — so ACA-compliance is inferred from `metal_level`:
 * a metal tier is an ACA-marketplace construct, so preventive care is federally
 * mandated at $0. Absent metal ⇒ null (unknown ⇒ the ACA $0 floor stays excluded,
 * matching `resolveSecondaryCoverage`'s confirmed-ACA-only rule).
 */
export async function loadCanonicalCoverageMeta(
  supabase: SupabaseClient,
  canonicalPlanIds: Array<string | null | undefined>,
): Promise<Map<string, PlanCoverageMeta>> {
  const out = new Map<string, PlanCoverageMeta>();
  const ids = Array.from(new Set(canonicalPlanIds.filter((id): id is string => Boolean(id))));
  if (ids.length === 0) return out;
  for (const id of ids) {
    out.set(id, { coverageMap: new Map(), coveredMeta: [], acaCompliant: null });
  }

  const { data: services, error } = await supabase
    .from("canonical_plan_services")
    .select("canonical_plan_id, service_slug, copay, coinsurance, is_covered")
    .in("canonical_plan_id", ids);
  if (error) {
    console.warn("[coverage-loader] loadCanonicalCoverageMeta services load failed", error);
  }
  const rows = services ?? [];
  const slugList = Array.from(
    new Set(rows.map((r) => r.service_slug as string | null).filter(Boolean) as string[]),
  );
  const categoryBySlug = new Map<string, string | null>();
  if (slugList.length > 0) {
    const { data: catalog } = await supabase
      .from("service_catalog")
      .select("slug, category")
      .in("slug", slugList);
    for (const c of catalog ?? []) {
      categoryBySlug.set(c.slug as string, (c.category as string | null) ?? null);
    }
  }
  for (const r of rows) {
    const entry = out.get(r.canonical_plan_id as string);
    if (!entry) continue;
    const slug = r.service_slug as string | null;
    if (!slug) continue;
    entry.coveredMeta.push({
      slug,
      category: categoryBySlug.get(slug) ?? null,
      coverage: {
        covered: r.is_covered as boolean | null,
        copay: r.copay as number | null,
        // canonical_plan_services.coinsurance may be integer-percent OR decimal;
        // normalize to decimal 0-1 (parity with loadPlanCoverageMeta).
        coinsurance: normalizeCoinsuranceForStorage(r.coinsurance as number | null),
      },
    });
  }

  const { data: plans } = await supabase
    .from("canonical_plans")
    .select("id, metal_level")
    .in("id", ids);
  for (const p of plans ?? []) {
    const entry = out.get(p.id as string);
    // D1 (S161) — metal tier present ⇒ ACA-marketplace plan ⇒ preventive $0
    // mandated. Absent ⇒ null (unknown; the ACA floor stays excluded).
    if (entry) entry.acaCompliant = (p.metal_level as string | null) ? true : null;
  }
  return out;
}

/**
 * S154 — batched bill-slug metadata (category + ACA-preventive eligibility)
 * for the secondary match, keyed by slug. One query across all distinct slugs.
 */
export async function loadBillSlugMeta(
  supabase: SupabaseClient,
  billSlugs: Array<string | null | undefined>,
): Promise<Map<string, BillSlugMeta>> {
  const map = new Map<string, BillSlugMeta>();
  const slugs = Array.from(new Set(billSlugs.filter((s): s is string => Boolean(s))));
  if (slugs.length === 0) return map;
  const { data, error } = await supabase
    .from("service_catalog")
    .select("slug, category, is_preventive_eligible")
    .in("slug", slugs);
  if (error) {
    console.warn("[coverage-loader] loadBillSlugMeta load failed", error);
    return map;
  }
  for (const r of data ?? []) {
    map.set(r.slug as string, {
      category: (r.category as string | null) ?? null,
      isPreventiveEligible: Boolean(r.is_preventive_eligible),
    });
  }
  return map;
}
