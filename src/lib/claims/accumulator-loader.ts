/**
 * Accumulator ledger — DB loader (Phase 1 wiring).
 *
 * Gathers a user's claims for one (plan, year) via the B9 userScoped layer, resolves
 * each line's coverage + prorated money with the SAME `resolveLinePrep` the /claim card
 * uses (so the accumulator's per-line inputs are byte-consistent with the card — the §18
 * "no surface contradicts another" rule), attributes each claim to a family member by
 * patient name, captures the insurer's own reported accumulator (`claim_accumulators`),
 * and threads it all through the pure `computeAccumulatorLedger`.
 *
 * B9: claims + line items + accumulators go through userScoped / selectOwnedChildren;
 * the plan is ownership-checked before its terms are read (no cross-user plan-term leak).
 *
 * Coverage fidelity: reuses the exact-slug → secondary → ACA-fallback cascade + preventive
 * membership the card resolves, so ACA-preventive lines are $0/deductible-exempt and
 * unslugged lines still match by category. Materiality is read from the flag config
 * (admin-tunable, §9). Rx denominators are null until mig 211 persists them (§4c: the Rx
 * bucket then shows "add your prescription deductible").
 *
 * SoT: plans/deductible_oop_accumulator_v1.md (§2 model, §17 loader reuse map).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { userScoped, selectOwnedChildren } from "../security/user-scoped";
import { isFeatureEnabled } from "../config/product-flags";
import {
  loadPlanCostShareParams,
  buildServiceCostShare,
  buildLineInsurer,
} from "./cost-share-loader";
import { resolveLinePrep, type ClaimCostSharePrep } from "./resolve-cost-share";
import { CANONICAL_IDENTITY_CONFIDENCE_FLOOR } from "../plan/plan-identity";
import {
  resolveEffectiveClaimTotals,
  readUserTotalsSource,
} from "./effective-totals";
import { buildAcaCoverageFallback, detectPreventiveMembership } from "../audit/aca-coverage-fallback";
import {
  loadPlanCoverageMeta,
  loadBillSlugMeta,
  loadSecondaryGate,
  DEFAULT_SECONDARY_GATE,
  type BillSlugMeta,
} from "../audit/coverage-loader";
import {
  computeAccumulatorLedger,
  decideAccumulatorCarry,
  DEFAULT_MATERIALITY,
  type AccumulatorLedger,
  type AccumulatorLedgerClaim,
  type AccumulatorLedgerLine,
  type InsurerAccumulatorRow,
  type Materiality,
  type SameYearAskBill,
} from "./accumulator-ledger";

const LINE_COLS =
  "id, line_number, service_slug, billing_code, billing_code_type, billed_amount, patient_owes, insurance_paid, description, amount_still_outstanding, patient_paid_amount, insurance_adjusted_amount, member_applied_to_deductible, member_coinsurance, member_copay, denied_amount, network_status";
const ACC_COLS =
  "claim_id, network_tier, accumulator_type, is_individual, deductible_applied, oop_applied";

/** Normalize a name for exact-normalized member matching (case/punct/space-insensitive). */
function normalizeName(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

interface DepLite {
  name: string;
  onSamePlan: boolean;
}
function parseDependents(raw: unknown): DepLite[] {
  let arr: unknown = raw;
  if (typeof raw === "string") {
    try {
      arr = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((d) => {
      const o = (d ?? {}) as Record<string, unknown>;
      return { name: String(o.name ?? ""), onSamePlan: o.on_same_plan !== false };
    })
    .filter((d) => d.name.length > 0);
}


/** S294 — the carry ladder's floor: the SAME tunable the upload resolver reads
 *  (`plan_identity_resolver_v1` config.canonical_confidence_floor; Ship Gate #6
 *  no-hardcoded-thresholds), falling back to the shared exported constant. One
 *  floor, one config key — the two identity consumers can never drift. */
async function loadCanonicalConfidenceFloor(supabase: SupabaseClient): Promise<number> {
  const { data } = await supabase
    .from("feature_flag_rules")
    .select("config")
    .eq("flag_key", "plan_identity_resolver_v1")
    .maybeSingle();
  const raw = (data?.config as Record<string, unknown> | null)?.canonical_confidence_floor;
  return typeof raw === "number" && raw > 0 && raw <= 1 ? raw : CANONICAL_IDENTITY_CONFIDENCE_FLOOR;
}

/** Materiality gate (§9) from the `accumulator_ledger_v1` flag config JSONB (admin-tunable). */
async function loadMateriality(supabase: SupabaseClient): Promise<Materiality> {
  const { data } = await supabase
    .from("feature_flag_rules")
    .select("config")
    .eq("flag_key", "accumulator_ledger_v1")
    .maybeSingle();
  const cfg = (data?.config as Record<string, unknown> | null) ?? null;
  const num = (k: string, d: number) => (typeof cfg?.[k] === "number" ? (cfg[k] as number) : d);
  return {
    dollars: num("materiality_dollars", DEFAULT_MATERIALITY.dollars),
    pct: num("materiality_pct", DEFAULT_MATERIALITY.pct),
  };
}

/**
 * Compute a user's deductible/OOP accumulator ledger for one (plan, year). Returns null
 * when the plan isn't the user's or has no cost-share terms (caller → panel hidden).
 */
export async function loadAccumulatorLedger(
  supabase: SupabaseClient,
  userId: string,
  insurancePlanId: string | null,
  planYear?: number | null,
): Promise<AccumulatorLedger | null> {
  // Profile drives BOTH the family scope (dependents) and the self-resolve fallback:
  // the /plan panel has no insurancePlanId in the generic plan-type view, so fall back
  // to the user's active plan. Keeps every user-table read owner-scoped here.
  const { data: profile } = await supabase
    .from("profiles")
    .select("dependents, active_insurance_plan_id")
    .eq("user_id", userId)
    .maybeSingle();
  const planId = insurancePlanId ?? (profile?.active_insurance_plan_id as string | null) ?? null;
  if (!planId) return null;

  // ── S294 MODEL (Andrew) — the accumulator is an instrument of the CURRENT
  // plan only. While a plan is active its bills accumulate; when a new plan
  // goes active the accumulator RESTARTS at $0; at the year boundary we PROMPT
  // for the new year's plan rather than silently rolling anything. (This
  // replaces the short-lived #266 divert-to-most-recent-billed-plan, which
  // could tally one benefit year against another year's denominators.)
  //
  // The one carry rule at switch time: SAME-YEAR bills sitting on another plan
  // row carry into this accumulator ONLY when that row provably IS this plan —
  // decided by the mig-218 canonical pair through decideAccumulatorCarry, the
  // same identity ladder (same floor, same config key) the upload resolver
  // uses. Provably different → excluded silently. Identity unknown → we ASK
  // (`sameYearAskCount`); the member's answer is the existing `claim_plan`
  // re-pin, which moves the bill onto this plan and flows in here naturally.
  // Bills are never re-pinned by the accumulator itself — read-side only.

  // B9 — ownership-check the plan before reading its terms (no cross-user leak); grab
  // plan_year + the canonical pair (the carry ladder's identity oracle).
  const { data: ownedPlan } = await userScoped(supabase, userId)
    .table("insurance_plans")
    .select("id, plan_year, plan_name, canonical_plan_id, canonical_match_confidence")
    .eq("id", planId)
    .maybeSingle();
  if (!ownedPlan) return null;
  const year = planYear ?? (ownedPlan.plan_year as number | null) ?? new Date().getUTCFullYear();

  const plan = await loadPlanCostShareParams(supabase, planId);
  if (!plan) return null;

  // Claims for this plan, filtered to the benefit year (no row cap — see §10).
  const { data: rawClaims, error } = await userScoped(supabase, userId)
    .table("claims")
    .select("*")
    .is("deleted_at", null)
    .eq("insurance_plan_id", planId);
  if (error) return null;
  const claimYear = (c: unknown): number | null => {
    const dos = (c as Record<string, unknown>).date_of_service as string | null;
    return dos ? new Date(dos).getUTCFullYear() : null;
  };
  const claimsForYear = (rawClaims ?? []).filter((c) => claimYear(c) === year);

  // ── Same-year bills on OTHER plan rows: carry / exclude / ask ─────────────
  const sameYearAsk: SameYearAskBill[] = [];
  {
    const { data: elsewhere } = await userScoped(supabase, userId)
      .table("claims")
      .select("*")
      .is("deleted_at", null)
      .neq("insurance_plan_id", planId)
      .not("insurance_plan_id", "is", null);
    const sameYearElsewhere = (elsewhere ?? []).filter((c) => claimYear(c) === year);
    if (sameYearElsewhere.length > 0) {
      const floor = await loadCanonicalConfidenceFloor(supabase);
      const otherPlanIds = Array.from(
        new Set(sameYearElsewhere.map((c) => (c as Record<string, unknown>).insurance_plan_id as string)),
      );
      const { data: otherPlans } = await userScoped(supabase, userId)
        .table("insurance_plans")
        .select("id, plan_name, canonical_plan_id, canonical_match_confidence")
        .in("id", otherPlanIds);
      const verdictByPlan = new Map<string, "carry" | "exclude" | "ask">();
      for (const p of otherPlans ?? []) {
        const row = p as Record<string, unknown>;
        verdictByPlan.set(
          row.id as string,
          decideAccumulatorCarry(
            {
              canonicalPlanId: (ownedPlan.canonical_plan_id as string | null) ?? null,
              canonicalMatchConfidence: (ownedPlan.canonical_match_confidence as number | null) ?? null,
            },
            {
              canonicalPlanId: (row.canonical_plan_id as string | null) ?? null,
              canonicalMatchConfidence: (row.canonical_match_confidence as number | null) ?? null,
            },
            floor,
          ),
        );
      }
      const planNameById = new Map<string, string | null>();
      for (const p of otherPlans ?? []) {
        planNameById.set((p as Record<string, unknown>).id as string, ((p as Record<string, unknown>).plan_name as string | null) ?? null);
      }
      for (const c of sameYearElsewhere) {
        const row = c as Record<string, unknown>;
        const verdict = verdictByPlan.get(row.insurance_plan_id as string) ?? "ask";
        if (verdict === "carry") claimsForYear.push(c);
        else if (verdict === "ask") {
          const meta = (row.metadata ?? {}) as Record<string, unknown>;
          sameYearAsk.push({
            claimId: row.id as string,
            providerName:
              ((meta.provider as Record<string, unknown> | undefined)?.name as string | undefined) ??
              ((row.provider_name as string | null) ?? null),
            dateOfService: (row.date_of_service as string | null) ?? null,
            totalBilled: row.total_billed == null ? null : Number(row.total_billed),
            currentPlanName: planNameById.get(row.insurance_plan_id as string) ?? null,
          });
        }
      }
    }
  }

  // Year boundary — the prompt, never a silent roll: a plan year behind the
  // clock means the member's NEW year has no plan document yet.
  const promptNewYearPlan = new Date().getUTCFullYear() > year;

  // Dependents → family scope + attribution (only those on the same plan count).
  const onPlanDeps = parseDependents(profile?.dependents).filter((d) => d.onSamePlan);
  const hasDependents = onPlanDeps.length > 0;
  const depNames = new Set(onPlanDeps.map((d) => normalizeName(d.name)));

  // Per-plan prep (batched once).
  const planMeta = (await loadPlanCoverageMeta(supabase, [planId])).get(planId);
  const coverageMap = planMeta?.coverageMap ?? new Map();
  const secondaryV2 = await isFeatureEnabled("secondary_coverage_v2");
  const secondaryGate = secondaryV2 ? await loadSecondaryGate(supabase) : DEFAULT_SECONDARY_GATE;
  const materiality = await loadMateriality(supabase);

  // Insurer-reported accumulators (batched, B9).
  const claimIds = claimsForYear.map((c) => (c as Record<string, unknown>).id as string);
  const accByClaim = new Map<string, InsurerAccumulatorRow[]>();
  if (claimIds.length > 0) {
    const accRows = await selectOwnedChildren(supabase, userId, "claim_accumulators", claimIds, ACC_COLS);
    for (const r of accRows ?? []) {
      const row = r as Record<string, unknown>;
      const cid = row.claim_id as string;
      const arr = accByClaim.get(cid) ?? [];
      arr.push({
        networkTier: String(row.network_tier ?? "unknown"),
        accumulatorType: String(row.accumulator_type ?? "medical"),
        isIndividual: Boolean(row.is_individual),
        deductibleApplied: row.deductible_applied == null ? null : Number(row.deductible_applied),
        oopApplied: row.oop_applied == null ? null : Number(row.oop_applied),
      });
      accByClaim.set(cid, arr);
    }
  }

  const ledgerClaims: AccumulatorLedgerClaim[] = [];
  for (const claim of claimsForYear) {
    const c = claim as Record<string, unknown>;
    const claimId = c.id as string;
    const items =
      (await selectOwnedChildren(supabase, userId, "claim_line_items", [claimId], LINE_COLS)) ?? [];
    const serviceDate = (c.date_of_service as string | null) ?? "";
    const patientName = (c.patient_name as string | null | undefined) ?? null;
    const claimTotalBilled = Number(c.total_billed || 0);
    const claimStillOutstanding =
      c.amount_still_outstanding != null
        ? Number(c.amount_still_outstanding)
        : c.total_patient_responsibility != null
          ? Number(c.total_patient_responsibility)
          : null;

    const liForAca = items.map((li) => {
      const r = li as Record<string, unknown>;
      return {
        lineNumber: Number(r.line_number ?? 0),
        procedureCode: (r.billing_code as string | null) ?? null,
        procedureCodeType: (r.billing_code_type as string | null) ?? null,
        serviceSlug: (r.service_slug as string | null) ?? null,
      };
    });
    const acaFallback = await buildAcaCoverageFallback({
      supabase,
      planId,
      userId,
      patientName,
      lineItems: liForAca,
      existingCoverageBySlug: new Set(coverageMap.keys()),
    });
    let billSlugMeta = new Map<string, BillSlugMeta>();
    if (secondaryV2) {
      billSlugMeta = await loadBillSlugMeta(
        supabase,
        items.map((li) => (li as Record<string, unknown>).service_slug as string | null),
      );
    }
    const preventiveLines = await detectPreventiveMembership({
      supabase,
      userId,
      patientName,
      lineItems: liForAca,
    });

    const prep: ClaimCostSharePrep = {
      coverageMap,
      coveredMeta: planMeta?.coveredMeta ?? [],
      billSlugMeta,
      planAcaCompliant: planMeta?.acaCompliant ?? null,
      secondaryGate,
      secondaryEnabled: secondaryV2,
      acaFallback,
      claimTotalBilled,
      claimStillOutstanding,
      effectiveTotals: resolveEffectiveClaimTotals({
        claim,
        lineItems: items,
        userTotalsSource: readUserTotalsSource(claim.metadata),
      }),
    };

    const lines: AccumulatorLedgerLine[] = items.map((li) => {
      const raw = li as Record<string, unknown>;
      const lp = resolveLinePrep(raw, prep, "detail");
      return {
        serviceDate,
        billed: Number(raw.billed_amount || 0),
        allowed: lp.allowed,
        insuranceAdjusted: lp.insuranceAdjusted,
        patientPaid: lp.patientPaid,
        patientResponsibility: lp.patientResponsibility,
        networkStatus: (raw.network_status as string | null) ?? null,
        service: buildServiceCostShare(lp.coverage),
        insurer: buildLineInsurer(raw),
        isPreventive: preventiveLines.has(Number(raw.line_number ?? 0)),
        // Rx = pharmacy-benefit NDC lines only (§18); in-office J-code drugs stay medical.
        isRx: String(raw.billing_code_type ?? "").toUpperCase() === "NDC",
      };
    });

    // Member attribution (exact-normalized dependent match; else the account holder).
    // Unmatched non-empty names → holder in v1 (UNASSIGNED_MEMBER strict family-cap-only
    // routing is a refinement pending a reliable holder-name source; §4b).
    const norm = normalizeName(patientName);
    const memberKey = norm && depNames.has(norm) ? norm : "holder";

    ledgerClaims.push({
      claimId,
      serviceDate,
      claimInsurerPaidZero: c.total_insurance_paid != null && Number(c.total_insurance_paid) === 0,
      memberKey,
      providerKey:
        normalizeName((c.metadata as { provider?: { name?: string } } | null)?.provider?.name) || null,
      insurerAccumulators: accByClaim.get(claimId) ?? [],
      lines,
    });
  }

  const ledger = computeAccumulatorLedger({
    plan,
    planYear: year,
    claims: ledgerClaims,
    hasDependents,
    materiality,
    // Rx denominators land with mig 211 (persist + backfill); null → "add your Rx deductible".
    rxDeductibleIndividual: null,
    rxDeductibleFamily: null,
  });
  // S294 model — the ask count + year-boundary prompt ride the ledger to the panel.
  return {
    ...ledger,
    sameYearAsk,
    promptNewYearPlan,
    planId,
    planName: (ownedPlan.plan_name as string | null) ?? null,
  };
}
