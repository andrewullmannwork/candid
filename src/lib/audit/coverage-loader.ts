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
import { loadCatalogIdentity } from "../plan/catalog-identity";
import type { PlanCoverageInput } from "../claims/recovery-math";
import type { ParsedBill } from "../billing/types";
import {
  buildAcaCoverageFallback,
  type AcaFallbackResult,
} from "./aca-coverage-fallback";
import { normalizeCoinsuranceForStorage } from "../billing/coinsurance";
// S294 — `canonical_coverage_completeness_v1` is a GLOBAL flag, so it resolves
// here rather than being threaded through all six loadPlanCoverageMeta call
// sites (claim detail, claims list, /compare, evidence resolver, dispute-ground
// basis, accumulator loader). Global target ⇒ no user email needed.
import { isFeatureEnabled } from "../config/product-flags";

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
      // deductibleApplies=false — ACA preventive is deductible-exempt by law.
      coverage: { covered: true, copay: 0, coinsurance: 0, deductibleApplies: false },
      matchedSlug: null,
      source: "aca_preventive",
      confidence: "confident",
    };
  }
  return null;
}

/**
 * Cost-Share v2 (S214) — build a richer PlanCoverageInput from a
 * plan_covered_services row (in + out terms + deductible-applies). The extra
 * fields are optional on PlanCoverageInput, so legacy/audit consumers are
 * unaffected; computeCostShareV2 reads them via buildServiceCostShare.
 */
/**
 * S291 — WHO said this cost-share, compressed to a tag the client can render
 * copy from. Never ships the field_provenance blob itself (it can carry parser
 * excerpts); just the attribution.
 *
 *   "user"    — a human typed it (user_correction / user_initial_entry)
 *   "card"    — scanned off an insurance card
 *   "unknown" — written before provenance stamping. GENUINELY unattributable:
 *               the card-scan and user-entry writers were byte-identical then,
 *               which is why mig 217 could not be written safely. Must never be
 *               rendered as "you told us" — we don't know that.
 */
function readCostProvenance(row: Record<string, unknown>): "user" | "card" | "unknown" {
  const fp = row.field_provenance as Record<string, { source?: string }> | null | undefined;
  const src = fp?.in_copay?.source ?? fp?.in_coinsurance?.source ?? null;
  if (src === "user_correction" || src === "user_initial_entry") return "user";
  if (src === "card_corroboration") return "card";
  // Row-level source still identifies post-fix card writes even if the blob
  // wasn't selected on this path.
  if ((row.source as string | null) === "insurance_card") return "card";
  return "unknown";
}

export function planCoverageFromRow(row: Record<string, unknown>): PlanCoverageInput {
  return {
    covered: (row.covered as boolean | null) ?? null,
    copay: (row.in_copay as number | null) ?? null,
    // in_coinsurance may be integer-percent OR decimal; normalizer → decimal 0-1.
    coinsurance: normalizeCoinsuranceForStorage(row.in_coinsurance as number | null),
    deductibleApplies: (row.in_deductible_applies as boolean | null) ?? null,
    costProvenance: readCostProvenance(row),
    outCopay: (row.out_copay as number | null) ?? null,
    outCoinsurance: normalizeCoinsuranceForStorage(row.out_coinsurance as number | null),
    outDeductibleApplies: (row.out_deductible_applies as boolean | null) ?? null,
    oonPaidAtInNetwork: (row.oon_paid_at_in_network as boolean | null) ?? null,
  };
}

// ============================================================================
// R1b (S240) — the shared user-scope coverage READ (plan_covered_services).
// ONE SELECT definition so future coverage columns (referral, visit_limit, …)
// land in a single place for all 3 user-scope adapters (audit / card / letter).
// `citeGrade` adds the dispute-letter columns; omitted for the parse-time audit
// path (no extra cost). Canonical scope reads differently (no service_catalog FK,
// smaller schema) — see loadCanonicalCoverageMeta / loadCoverageFromCanonical.
// ============================================================================
const COVERAGE_BASE_SELECT =
  "insurance_plan_id, covered, in_copay, in_coinsurance, in_deductible_applies, out_copay, out_coinsurance, out_deductible_applies, oon_paid_at_in_network, source, field_provenance, service_catalog!inner(slug, category, name)";
const COVERAGE_CITEGRADE_SELECT = "confidence, sbc_excerpt, sbc_page, field_provenance";

/** The user-scope coverage SELECT — base, plus the dispute-letter cite-grade columns when asked. */
export function coverageSelect(citeGrade: boolean): string {
  return citeGrade ? `${COVERAGE_BASE_SELECT}, ${COVERAGE_CITEGRADE_SELECT}` : COVERAGE_BASE_SELECT;
}

// ============================================================================
// S294 — the CANONICAL-scope coverage READ. Twin of COVERAGE_BASE_SELECT above.
// ============================================================================
//
// The user-scope side has had ONE shared column list since S240 precisely so a
// new coverage column lands in a single place for every adapter. The canonical
// side never got the same treatment: four call sites each hand-wrote their own
// list, and three of them omitted `in_deductible_applies`.
//
// The cost of that omission is not a missing display field — it changes the
// ANSWER. A canonical row reading `in_copay=0, in_deductible_applies=true`
// ("No Charge after deductible", straight off the SBC) arrived at the engine as
// "$0 copay, deductible treatment unknown". The engine then inferred the
// missing half, could not ground the result, and degraded the whole bill to
// "we can't fully check this one yet" — while `/plan`, which selects the full
// row, displayed the correct terms on the same plan at the same moment.
//
// Everything below is a column the table already holds and
// `PlanCoverageInput` already declares. Nothing is invented here.
const CANONICAL_COVERAGE_SELECT =
  "id, canonical_plan_id, service_slug, place_of_service, component, plan_tier_label, " +
  "covered, in_copay, in_coinsurance, in_deductible_applies, " +
  "out_copay, out_coinsurance, out_deductible_applies, " +
  "requires_referral, prior_auth_required, visit_limit, annual_limit, confidence, source";

/**
 * Shared canonical coverage row fetch, batched over canonical plan ids.
 *
 * ORDERING IS PART OF THE CONTRACT, not a nicety. A slug can carry several
 * Pattern-S variants (this corpus has `pcp_visit` at both `pcp_office` and
 * `virtual`), and every consumer collapses them into one slug-keyed map. With
 * no ORDER BY, which variant survived was Postgres heap order — stable until a
 * VACUUM, then silently different. S289 killed exactly this nondeterminism in
 * /compare; the shared read now carries the fix for everyone.
 *
 * Precedence: `any` (the umbrella row) first, then remaining variants by
 * place_of_service, then id. Consumers take FIRST-WINS.
 *
 * NOTE — this deliberately picks a *stable* variant, not the *right* one for a
 * given bill line. Matching a line's actual place of service against Pattern-S
 * modifiers is a real feature and a separate one; it is not needed to fix the
 * dropped column, and pretending otherwise would smuggle a second change in
 * here. Where variants disagree, consumers still see one deterministic answer.
 */
export async function loadCanonicalCoverageRows(
  supabase: SupabaseClient,
  canonicalPlanIds: string[],
): Promise<{ data: Record<string, unknown>[] | null; error: unknown }> {
  const { data, error } = await supabase
    .from("canonical_plan_services")
    .select(CANONICAL_COVERAGE_SELECT)
    .in("canonical_plan_id", canonicalPlanIds)
    // `any` sorts before every concrete place_of_service value in this corpus
    // ('any' < 'pcp_office' < 'specialist_office' < 'virtual'); the explicit id
    // tiebreak makes the order total rather than merely usually-stable.
    .order("place_of_service", { ascending: true, nullsFirst: true })
    .order("id", { ascending: true });
  return { data: (data as unknown as Record<string, unknown>[] | null) ?? null, error };
}

/**
 * S294 — canonical row → PlanCoverageInput. Canonical parity with
 * `planCoverageFromRow`, so a service resolved from the community catalog and
 * the same service resolved from the user's own upload reach the engine in the
 * SAME shape.
 *
 * `costProvenance` is deliberately absent: canonical rows are not the user's
 * own document, and the caller tags them `canonical_inherited` /
 * `canonical_archive` so the letter layer keeps that distinction.
 */
export function canonicalCoverageFromRow(row: Record<string, unknown>): PlanCoverageInput {
  return {
    covered: (row.covered as boolean | null) ?? null,
    copay: (row.in_copay as number | null) ?? null,
    // canonical_plan_services.in_coinsurance is decimal-stored; normalize
    // defensively (parity with planCoverageFromRow).
    coinsurance: normalizeCoinsuranceForStorage(row.in_coinsurance as number | null),
    // THE COLUMN THIS WHOLE MODULE EXISTS FOR. Absent → null → the engine
    // infers, which is the pre-S294 behavior and still correct for rows the
    // parser genuinely could not resolve.
    deductibleApplies: (row.in_deductible_applies as boolean | null) ?? null,
    outCopay: (row.out_copay as number | null) ?? null,
    outCoinsurance: normalizeCoinsuranceForStorage(row.out_coinsurance as number | null),
    outDeductibleApplies: (row.out_deductible_applies as boolean | null) ?? null,
  };
}

/**
 * Shared user-scope coverage row fetch (plan_covered_services), batched over plan ids.
 * Returns the raw Supabase response so each adapter keeps its own error handling + row
 * mapping (planCoverageFromRow for card/audit; buildPlanBenefitFromRow for the letter).
 * Extra columns beyond a given adapter's needs are ignored by its mapper (byte-identical).
 */
export async function loadCoverageRows(
  supabase: SupabaseClient,
  insurancePlanIds: string[],
  opts: { citeGrade: boolean },
): Promise<{ data: Record<string, unknown>[] | null; error: unknown }> {
  // A runtime-string .select() loses PostgREST's row-type inference (→ GenericStringError);
  // cast to the loose row shape each adapter already maps from (planCoverageFromRow /
  // buildPlanBenefitFromRow read named fields; extras are ignored).
  const { data, error } = await supabase
    .from("plan_covered_services")
    .select(coverageSelect(opts.citeGrade))
    .in("insurance_plan_id", insurancePlanIds);
  return { data: (data as unknown as Record<string, unknown>[] | null) ?? null, error };
}

export async function loadCoverageMapForPlan(
  supabase: SupabaseClient,
  insurancePlanId: string | null | undefined,
): Promise<PlanCoverageMap | null> {
  if (!insurancePlanId) return null;
  const { data, error } = await loadCoverageRows(supabase, [insurancePlanId], { citeGrade: false });
  if (error) {
    console.warn("[coverage-loader] failed to load coverage for plan", insurancePlanId, error);
    return null;
  }
  const map: PlanCoverageMap = new Map();
  for (const row of data ?? []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const slug = (row.service_catalog as any)?.slug as string | undefined;
    if (!slug) continue;
    // S132 iter-11 — in_coinsurance may be integer-percent OR decimal; the
    // normalizer (inside planCoverageFromRow) returns decimal 0-1 uniformly.
    map.set(slug, planCoverageFromRow(row as unknown as Record<string, unknown>));
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
 *
 * S290 — canonical fallback for coverage-empty plans. A search-selected plan
 * (`source='catalog_match'` / any pure-canonical row) keeps its coverage on
 * `canonical_plan_services`, NOT user-scoped `plan_covered_services` — so this
 * loader returned an EMPTY context for it and the ungated same-category sibling
 * match (path 1 of resolveSecondaryCoverage) could never run; only the
 * ACA-gated backstop could ever answer (the "plan says $0 but line reads
 * Unknown" S290 E2E defect). Now: a plan with zero user-scoped rows AND a
 * `canonical_plan_id` inherits the canonical coverage (marked
 * `canonical_inherited`) plus the S161 D1 metal-level→ACA inference — a user
 * plan's explicit `is_aca_compliant` (incl. user_override) always wins.
 * Plans with ANY user-scoped rows are untouched (docs stay authoritative);
 * merge-under for hybrid doc+canonical plans is a named follow-up, not this.
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

  const { data: covered, error } = await loadCoverageRows(supabase, ids, { citeGrade: false });
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
      const coverage = planCoverageFromRow(row as unknown as Record<string, unknown>);
      entry.coverageMap.set(slug, { ...coverage, source: (row.source as string | null) ?? null });
      entry.coveredMeta.push({ slug, category: (sc?.category as string | null) ?? null, coverage });
    }
  }

  const { data: plans } = await supabase
    .from("insurance_plans")
    .select("id, is_aca_compliant, canonical_plan_id")
    .in("id", ids);
  const canonicalByPlan = new Map<string, string>();
  // S294 — plans that had ZERO user-scoped coverage rows. This is the ONLY set
  // permitted to take the canonical's metal-level ACA guess (see below).
  const acaEligiblePlanIds = new Set<string>();
  // S294 — gap-fill replaces the all-or-nothing rule. Flag-gated: OFF keeps the
  // pre-S294 condition (canonical only when the plan has no coverage rows).
  const completeness = await isFeatureEnabled("canonical_coverage_completeness_v1");
  for (const p of plans ?? []) {
    const entry = out.get(p.id as string);
    if (!entry) continue;
    entry.acaCompliant = (p.is_aca_compliant as boolean | null) ?? null;
    const canonicalId = p.canonical_plan_id as string | null;
    if (!canonicalId) continue;
    const hasUserRows = entry.coveredMeta.length > 0;
    if (!hasUserRows) acaEligiblePlanIds.add(p.id as string);
    // Pre-S294: candidates were zero-user-row plans only. With the flag ON,
    // ANY plan with a linked canonical is a candidate — the canonical fills
    // gaps beneath the user's own rows rather than replacing them wholesale.
    if (completeness || !hasUserRows) {
      canonicalByPlan.set(p.id as string, canonicalId);
    }
  }

  if (canonicalByPlan.size > 0) {
    const canonMeta = await loadCanonicalCoverageMeta(
      supabase,
      Array.from(new Set(canonicalByPlan.values())),
    );
    for (const [planId, canonicalId] of canonicalByPlan) {
      const entry = out.get(planId);
      const canon = canonMeta.get(canonicalId);
      if (!entry || !canon) continue;
      applyCanonicalGapFill(entry, canon, {
        allowAcaInference: acaEligiblePlanIds.has(planId),
      });
    }
  }
  return out;
}

/**
 * S294 — the canonical-under-user merge POLICY, pure and separately testable.
 *
 * The user's own documents WIN on every service they cover; canonical fills
 * only slugs those documents never mention. This is the S286 supplement-merge
 * policy (fill gaps, never erase) applied to the READ path, which is where it
 * always belonged.
 *
 * The pre-S294 code did `entry.coveredMeta = canon.coveredMeta` — a wholesale
 * REPLACE that was only safe because it ran exclusively on plans with no
 * coverage rows. Uploading a plan document therefore REMOVED coverage the user
 * could see the day before: one `plan_covered_services` row and the canonical
 * vanished entirely, taking every service the upload didn't enumerate with it.
 *
 * Filled rows keep the `canonical_inherited` tag, so provenance stays visible
 * and the letter layer's gating is unchanged.
 *
 * ⚠ `allowAcaInference` exists to STOP the metal-level ACA guess widening as a
 * side effect of gap-fill. It stays reachable only for plans that had zero
 * user-scoped rows — exactly its pre-S294 reach. Andrew's S154
 * confirmed-ACA-only direction was reaffirmed at S294 (a metal tier is not an
 * ACA entailment: large-group plans are marketed with tier names, grandfathered
 * plans are exempt from §2713, and the column is parser-populated from document
 * text). Letting it ride along here would have been a silent policy change
 * smuggled in by an unrelated fix. Explicit user answers always win.
 */
export function applyCanonicalGapFill(
  entry: PlanCoverageMeta,
  canon: PlanCoverageMeta,
  opts: { allowAcaInference: boolean },
): PlanCoverageMeta {
  for (const m of canon.coveredMeta) {
    if (entry.coverageMap.has(m.slug)) continue; // user row wins, always
    entry.coverageMap.set(m.slug, { ...m.coverage, source: "canonical_inherited" });
    entry.coveredMeta.push(m);
  }
  if (entry.acaCompliant == null && opts.allowAcaInference) {
    entry.acaCompliant = canon.acaCompliant;
  }
  return entry;
}

/**
 * S161 (#1/#3) — canonical analog of `loadPlanCoverageMeta` for the /compare
 * preventive backstop. `canonical_plan_services` has no FK to `service_catalog`
 * (unlike `plan_covered_services`), so category comes from a second lookup.
 *
 * `canonical_plans` carries no `is_aca_compliant` column (that lives only on
 * `insurance_plans`, mig 093), so ACA-compliance is guessed from `metal_level`.
 *
 * ⚠ S294 — that guess is a HEURISTIC, not an entailment, and the previous
 * comment here overstated it. A metal tier does not prove an ACA plan: large-
 * group and self-insured plans are routinely marketed with tier names,
 * grandfathered plans are exempt from §2713 regardless, short-term products
 * borrow the same vocabulary, and this column is parser-populated from document
 * text — it records what the document SAID, not the plan's regulatory status.
 *
 * Kept as-is at S294 (behavior unchanged, Andrew's call) because it is narrowly
 * scoped: it only ever fills the UNKNOWN case, an explicit user answer always
 * wins, and its single consumer — `resolveSecondaryCoverage`'s preventive
 * backstop — is the weakest link in the coverage cascade. Do not widen its
 * reach without a decision; `loadPlanCoverageMeta` deliberately guards it (see
 * `acaEligiblePlanIds` there).
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

  const { data: services, error } = await loadCanonicalCoverageRows(supabase, ids);
  if (error) {
    console.warn("[coverage-loader] loadCanonicalCoverageMeta services load failed", error);
  }
  const rows = services ?? [];
  // S289 — shared merge-chain resolver (was an inline slug→category two-query
  // merge; one implementation now serves /compare, /plan gap-fill, and here).
  const catalogIdentity = await loadCatalogIdentity(
    supabase,
    rows.map((r) => r.service_slug as string | null),
  );
  // S294 — FIRST-WINS variant collapse, per loadCanonicalCoverageRows' ordering
  // contract (`any` umbrella first, then place_of_service, then id). Previously
  // this pushed EVERY variant and let the slug-keyed consumers resolve the
  // collision by heap order.
  const seenSlugPerPlan = new Map<string, Set<string>>();
  for (const r of rows) {
    const planId = r.canonical_plan_id as string;
    const entry = out.get(planId);
    if (!entry) continue;
    const slug = r.service_slug as string | null;
    if (!slug) continue;
    let seen = seenSlugPerPlan.get(planId);
    if (!seen) {
      seen = new Set<string>();
      seenSlugPerPlan.set(planId, seen);
    }
    if (seen.has(slug)) continue;
    seen.add(slug);
    entry.coveredMeta.push({
      slug,
      category: catalogIdentity.get(slug)?.category ?? null,
      // S294 — the shared mapper. Carries in_deductible_applies + out_* rather
      // than the three-field subset this loader used to build by hand.
      coverage: canonicalCoverageFromRow(r),
    });
  }

  const { data: plans } = await supabase
    .from("canonical_plans")
    .select("id, metal_level")
    .in("id", ids);
  for (const p of plans ?? []) {
    const entry = out.get(p.id as string);
    // D1 (S161) — metal tier present ⇒ TREAT as ACA-marketplace for the
    // preventive backstop. See the heuristic caveat in this function's doc
    // comment. Absent ⇒ null (unknown; the ACA floor stays excluded).
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
