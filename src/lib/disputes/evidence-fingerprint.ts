// S74.5 D16 — Evidence fingerprint helper for dispute auto-refresh.
//
// Per plans/s74.5_categorization_flywheel.md v2 §7.5 + G2/Q-F/Q-I/Q-M LOCK.
//
// Computes a sha256 fingerprint over the audit evidence that informed a
// dispute letter: findings (type + slug + amount), line item slugs, and the
// total recovery estimate. Compare stored fingerprint vs current at view
// time to detect drift after category corrections.

import * as crypto from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuditFinding } from "../billing/types";
import { userScoped, selectOwnedChildren } from "@/lib/security/user-scoped";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import {
  loadPlanCostShareParams,
  loadCostShareOverrides,
  mapRawAccumulator,
  coerceNetworkOverride,
} from "@/lib/claims/cost-share-loader";
import {
  loadCoverageMapForPlan,
  loadAcaCompliantFlagForPlan,
} from "@/lib/audit/coverage-loader";
import type {
  PlanCostShareParams,
  CostShareOverrides,
  PlanCoverageInput,
} from "@/lib/claims/recovery-math";

interface LineItemSlugInput {
  service_slug: string | null;
  line_number?: number;
}

/**
 * Cost-Share v2 (Finding 4) — the per-line raw financial inputs the recovery
 * engine reads. Hashing these (not the engine OUTPUT) closes the cf91a49e
 * class: recoveries the AUDIT finds nothing on (so the findings hash is blind)
 * but the cost-share engine flags — a re-parse that moves these numbers must
 * restage the letter.
 */
export interface CostShareBasisLine {
  lineNumber: number | null;
  billedAmount: number | null;
  insuranceAdjustedAmount: number | null;
  insurancePaid: number | null;
  patientPaidAmount: number | null;
  patientOwes: number | null;
  amountStillOutstanding: number | null;
  memberAppliedToDeductible: number | null;
  memberCoinsurance: number | null;
  memberCopay: number | null;
  deniedAmount: number | null;
  networkStatus: string | null;
  billingCode: string | null;
  billingCodeType: string | null;
}

/**
 * Cost-Share v2 (Finding 4) — the COMPLETE set of inputs the cost-share
 * recovery is a function of. Folded into the evidence fingerprint (flag-gated)
 * so any cost-share correction (the W4 trigger) drifts the hash → the
 * persistent letter flags stale. We hash raw inputs (over-flag-safe; never
 * under-flags a stale letter as current).
 */
export interface CostShareBasis {
  plan: {
    params: PlanCostShareParams | null;
    /**
     * The WHOLE plan coverage map (not scoped to this claim's slugs): the
     * engine resolves a line's coverage through category/sibling matching, so a
     * SIBLING service's coverage edit can change this bill's recovery — a
     * slug-scoped hash would miss it (silent under-flag). See loadCostShareBasis.
     */
    coverage: Array<{ slug: string } & PlanCoverageInput>;
    acaCompliant: boolean | null;
  };
  claim: {
    dateOfService: string | null;
    networkStatus: string | null;
    userNetworkOverride: string | null;
    totalBilled: number | null;
    totalInsurancePaid: number | null;
    amountStillOutstanding: number | null;
    totalPatientResponsibility: number | null;
    insurancePlanId: string | null;
  };
  lines: CostShareBasisLine[];
  accumulators: Array<{
    benefitYear: string;
    networkTier: string;
    accumulatorType: string;
    isIndividual: boolean;
    deductibleApplied: number | null;
    deductibleMax: number | null;
    oopApplied: number | null;
    oopMax: number | null;
  }>;
  overrides: CostShareOverrides;
}

export interface FingerprintInput {
  findings: Array<Pick<AuditFinding, "type"> & { slug?: string | null; amount?: number }>;
  lineItems: LineItemSlugInput[];
  totalRecoveryEstimate: number;
  /**
   * Cost-Share v2 (Finding 4) — present ONLY when recovery_cost_share_v2 is ON.
   * Absent → the fingerprint is byte-identical to the pre-Finding-4 hash.
   */
  costShareBasis?: CostShareBasis | null;
}

/**
 * Load the FingerprintInput shape from a persisted claim. Reads
 * claim_line_items (service_slug + metadata.auditFindings) plus
 * claim.metadata.auditSummary.totalEstimatedOvercharge. When
 * recovery_cost_share_v2 is ON it ALSO loads the full cost-share recovery basis
 * (Finding 4) so a cost-share correction drifts the fingerprint.
 *
 * Returns null if the claim or line items can't be loaded.
 */
export async function loadFingerprintInputForClaim(
  supabase: SupabaseClient,
  claimId: string,
  userId: string,
): Promise<FingerprintInput | null> {
  // Cost-Share v2 (Finding 4) — read the flag HERE (not at the three call
  // sites: draft-store, sent-store, view-compare) so every path produces the
  // SAME fingerprint shape and can't diverge. OFF → no extra columns, no basis,
  // byte-identical fingerprint to before.
  const costShareV2 = await isFeatureEnabled("recovery_cost_share_v2");

  // B9-F12 — claimId is caller/request-supplied (disputes/generate passes
  // body.claimId; outcome / [disputeId] pass a dispute's claim_id, which a Pro
  // user could have smuggled in foreign since persist doesn't validate claim
  // ownership). Scope both reads to the authenticated user via the B1 layer:
  // a foreign claimId yields no claim → null (no fingerprint, no cross-tenant
  // read). createServerClient bypasses RLS, so this app-layer scope enforces it.
  const { data: claim } = await userScoped(supabase, userId)
    .table("claims")
    .select(
      costShareV2
        ? "id, metadata, insurance_plan_id, date_of_service, network_status, user_network_override, total_billed, total_insurance_paid, amount_still_outstanding, total_patient_responsibility"
        : "id, metadata",
    )
    .eq("id", claimId)
    .maybeSingle();
  if (!claim) return null;

  // selectOwnedChildren scopes line items to the owned claim; re-apply the
  // line_number order the prior `.order(...)` provided (the fingerprint hash
  // sorts internally, so this is belt-and-suspenders for op-equivalence).
  const lineItems = (
    await selectOwnedChildren(
      supabase,
      userId,
      "claim_line_items",
      [claimId],
      costShareV2
        ? "line_number, service_slug, metadata, billed_amount, insurance_adjusted_amount, insurance_paid, patient_paid_amount, patient_owes, amount_still_outstanding, member_applied_to_deductible, member_coinsurance, member_copay, denied_amount, network_status, billing_code, billing_code_type"
        : "line_number, service_slug, metadata",
    )
  ).sort((a, b) => (a.line_number ?? 0) - (b.line_number ?? 0));

  const claimMeta = (claim.metadata as Record<string, unknown> | null) ?? {};
  const auditSummary =
    (claimMeta.auditSummary as
      | {
          totalEstimatedOvercharge?: number;
          claimLevelFindings?: Array<{
            type?: string;
            estimatedOvercharge?: number;
            dismissed?: boolean;
          }>;
        }
      | undefined) ?? null;
  const totalRecoveryEstimate = Number(
    auditSummary?.totalEstimatedOvercharge ?? 0,
  );

  // S74.5c §2.5 + §1.7 + §2.7 — flatten findings from BOTH per-line metadata
  // and claim-level metadata. Filter out dismissed findings (§2.5) so a
  // dispute letter regenerates when the user signals "this evidence isn't
  // real." Dedup by kind-prefixed (kind, type, slug, amount) — C-9 fix
  // prevents a slug-less line-level finding from colliding with a
  // structurally-identical claim-level finding (both would compute the same
  // bare `type||amount` key; the "line" / "claim" prefix disambiguates them).
  type FindingShape = {
    type?: string;
    estimatedOvercharge?: number;
    dismissed?: boolean;
  };
  const findings: FingerprintInput["findings"] = [];
  const seen = new Set<string>();

  for (const li of lineItems ?? []) {
    const liMeta = (li.metadata as Record<string, unknown> | null) ?? {};
    const items =
      (liMeta.auditFindings as FindingShape[] | undefined) ?? [];
    for (const f of items) {
      if (f.dismissed) continue;
      const type = f.type ?? "unknown";
      const slug = (li.service_slug as string | null) ?? null;
      const amount = Number(f.estimatedOvercharge ?? 0);
      const key = `line|${type}|${slug ?? ""}|${amount}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ type: type as AuditFinding["type"], slug, amount });
    }
  }

  // §1.7 — claim-level findings (D15 unallocated_balance + future claim-header
  // findings). slug=null since they don't attach to any single line.
  const claimLevel = auditSummary?.claimLevelFindings ?? [];
  for (const f of claimLevel) {
    if (f.dismissed) continue;
    const type = f.type ?? "unknown";
    const amount = Number(f.estimatedOvercharge ?? 0);
    const key = `claim|${type}|${amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ type: type as AuditFinding["type"], slug: null, amount });
  }

  const costShareBasis = costShareV2
    ? await loadCostShareBasis(supabase, userId, claim, lineItems ?? [])
    : null;

  return {
    findings,
    lineItems: (lineItems ?? []).map((li) => ({
      service_slug: (li.service_slug as string | null) ?? null,
      line_number: li.line_number as number,
    })),
    totalRecoveryEstimate,
    // Present ONLY when the flag is ON → absent keeps the hash byte-identical.
    ...(costShareBasis ? { costShareBasis } : {}),
  };
}

/**
 * Cost-Share v2 (Finding 4) — assemble the full recovery basis for the
 * fingerprint via the SAME loaders the claim route feeds the engine, so any
 * change to any recovery input (coverage, plan params, accumulators, overrides,
 * network, ACA, or the bill's own line/claim numbers) drifts the hash. Hashes
 * raw INPUTS, never the engine output: over-flags at worst (a refresh that
 * yields the same letter), NEVER under-flags (a stale letter shown as current).
 *
 * Coverage is the WHOLE plan map: the engine resolves a line's coverage through
 * category/sibling matching (resolveSecondaryCoverage), so a sibling service's
 * edit can change THIS bill's recovery — a slug-scoped hash would miss it.
 */
async function loadCostShareBasis(
  supabase: SupabaseClient,
  userId: string,
  claim: Record<string, unknown>,
  lineItems: Array<Record<string, unknown>>,
): Promise<CostShareBasis> {
  const planId = (claim.insurance_plan_id as string | null) ?? null;
  const planYear = claim.date_of_service
    ? new Date(claim.date_of_service as string).getUTCFullYear()
    : null;

  const [planParams, coverageMap, acaCompliant, accumRows, overrides] =
    await Promise.all([
      loadPlanCostShareParams(supabase, planId),
      loadCoverageMapForPlan(supabase, planId),
      loadAcaCompliantFlagForPlan(supabase, planId),
      // claim_accumulators is claim-child data — read via the B9 owned-children
      // primitive (parent-join), matching the user-facing claim route.
      selectOwnedChildren(
        supabase,
        userId,
        "claim_accumulators",
        [claim.id as string],
        "benefit_year, network_tier, accumulator_type, is_individual, deductible_applied, deductible_max, oop_applied, oop_max",
      ),
      loadCostShareOverrides(
        supabase,
        userId,
        planId,
        planYear,
        coerceNetworkOverride(claim.user_network_override),
      ),
    ]);

  const coverage = coverageMap
    ? Array.from(coverageMap.entries()).map(([slug, c]) => ({ slug, ...c }))
    : [];

  const accumulators = (accumRows ?? []).map((row) => {
    const r = mapRawAccumulator(row);
    return {
      benefitYear: r.benefitYear,
      networkTier: r.networkTier,
      accumulatorType: r.accumulatorType,
      isIndividual: r.isIndividual,
      deductibleApplied: r.deductibleApplied,
      deductibleMax: r.deductibleMax,
      oopApplied: r.oopApplied,
      oopMax: r.oopMax,
    };
  });

  const num = (r: Record<string, unknown>, k: string) =>
    r[k] == null ? null : Number(r[k]);
  const str = (r: Record<string, unknown>, k: string) =>
    r[k] == null ? null : String(r[k]);

  const lines: CostShareBasisLine[] = lineItems.map((r) => ({
    lineNumber: r.line_number == null ? null : Number(r.line_number),
    billedAmount: num(r, "billed_amount"),
    insuranceAdjustedAmount: num(r, "insurance_adjusted_amount"),
    insurancePaid: num(r, "insurance_paid"),
    patientPaidAmount: num(r, "patient_paid_amount"),
    patientOwes: num(r, "patient_owes"),
    amountStillOutstanding: num(r, "amount_still_outstanding"),
    memberAppliedToDeductible: num(r, "member_applied_to_deductible"),
    memberCoinsurance: num(r, "member_coinsurance"),
    memberCopay: num(r, "member_copay"),
    deniedAmount: num(r, "denied_amount"),
    networkStatus: str(r, "network_status"),
    billingCode: str(r, "billing_code"),
    billingCodeType: str(r, "billing_code_type"),
  }));

  return {
    plan: { params: planParams, coverage, acaCompliant },
    claim: {
      dateOfService: (claim.date_of_service as string | null) ?? null,
      networkStatus: (claim.network_status as string | null) ?? null,
      userNetworkOverride: (claim.user_network_override as string | null) ?? null,
      totalBilled: num(claim, "total_billed"),
      totalInsurancePaid: num(claim, "total_insurance_paid"),
      amountStillOutstanding: num(claim, "amount_still_outstanding"),
      totalPatientResponsibility: num(claim, "total_patient_responsibility"),
      insurancePlanId: planId,
    },
    lines,
    accumulators,
    overrides,
  };
}

// Cost-Share v2 (Finding 4) — money is rounded to integer cents and coinsurance
// to a 4-dp fraction so float noise can't spuriously drift the hash; every
// array is sorted so DB row order can't either.
function fpCents(v: number | null | undefined): number | null {
  return v == null ? null : Math.round(v * 100);
}
function fpFraction(v: number | null | undefined): number | null {
  return v == null ? null : Math.round(v * 10000) / 10000;
}

function canonicalizeCostShareBasis(b: CostShareBasis) {
  const p = b.plan.params;
  return {
    plan: {
      params:
        p == null
          ? null
          : {
              in_ded_ind: fpCents(p.inDeductibleIndividual),
              in_ded_fam: fpCents(p.inDeductibleFamily),
              out_ded_ind: fpCents(p.outDeductibleIndividual),
              out_ded_fam: fpCents(p.outDeductibleFamily),
              in_oop_ind: fpCents(p.inOopMaxIndividual),
              in_oop_fam: fpCents(p.inOopMaxFamily),
              out_oop_ind: fpCents(p.outOopMaxIndividual),
              out_oop_fam: fpCents(p.outOopMaxFamily),
              in_coins: fpFraction(p.inCoinsuranceDefault),
              out_coins: fpFraction(p.outCoinsuranceDefault),
              ded_method: p.deductibleCalcMethod ?? null,
              combined_oop: p.combinedMedicalRxOop ?? null,
              tier: p.coverageTier ?? null,
            },
      coverage: b.plan.coverage
        .map((c) => ({
          slug: c.slug,
          covered: c.covered ?? null,
          copay: fpCents(c.copay ?? null),
          coins: fpFraction(c.coinsurance ?? null),
          ded_applies: c.deductibleApplies ?? null,
          out_copay: fpCents(c.outCopay ?? null),
          out_coins: fpFraction(c.outCoinsurance ?? null),
          out_ded_applies: c.outDeductibleApplies ?? null,
          oon_at_in: c.oonPaidAtInNetwork ?? null,
        }))
        .sort((a, z) => a.slug.localeCompare(z.slug)),
      aca: b.plan.acaCompliant ?? null,
    },
    claim: {
      dos: b.claim.dateOfService ?? null,
      net: b.claim.networkStatus ?? null,
      net_override: b.claim.userNetworkOverride ?? null,
      total_billed: fpCents(b.claim.totalBilled),
      total_ins_paid: fpCents(b.claim.totalInsurancePaid),
      still_out: fpCents(b.claim.amountStillOutstanding),
      total_pr: fpCents(b.claim.totalPatientResponsibility),
      plan_id: b.claim.insurancePlanId ?? null,
    },
    lines: b.lines
      .map((l) => ({
        ln: l.lineNumber,
        billed: fpCents(l.billedAmount),
        ins_adj: fpCents(l.insuranceAdjustedAmount),
        ins_paid: fpCents(l.insurancePaid),
        pt_paid: fpCents(l.patientPaidAmount),
        pt_owes: fpCents(l.patientOwes),
        still_out: fpCents(l.amountStillOutstanding),
        mem_ded: fpCents(l.memberAppliedToDeductible),
        mem_coins: fpCents(l.memberCoinsurance),
        mem_copay: fpCents(l.memberCopay),
        denied: fpCents(l.deniedAmount),
        net: l.networkStatus ?? null,
        code: l.billingCode ?? null,
        code_type: l.billingCodeType ?? null,
      }))
      .sort(
        (a, z) =>
          (a.ln ?? 0) - (z.ln ?? 0) ||
          (a.code ?? "").localeCompare(z.code ?? ""),
      ),
    accumulators: b.accumulators
      .map((a) => ({
        yr: a.benefitYear,
        net: a.networkTier,
        type: a.accumulatorType,
        ind: a.isIndividual,
        ded_applied: fpCents(a.deductibleApplied),
        ded_max: fpCents(a.deductibleMax),
        oop_applied: fpCents(a.oopApplied),
        oop_max: fpCents(a.oopMax),
      }))
      .sort(
        (a, z) =>
          a.yr.localeCompare(z.yr) ||
          a.net.localeCompare(z.net) ||
          a.type.localeCompare(z.type) ||
          (a.ind === z.ind ? 0 : a.ind ? 1 : -1),
      ),
    overrides: {
      ded_met: b.overrides.deductibleMet ?? null,
      ded_as_of: b.overrides.deductibleMetAsOf ?? null,
      oop_met: b.overrides.oopMet ?? null,
      oop_as_of: b.overrides.oopMetAsOf ?? null,
      net_override: b.overrides.userNetworkOverride ?? null,
    },
  };
}

export function computeEvidenceFingerprint(input: FingerprintInput): string {
  const base = {
    findings: input.findings
      .map((f) => ({
        type: f.type,
        slug: f.slug ?? null,
        amount: typeof f.amount === "number" ? Math.round(f.amount * 100) : null,
      }))
      .sort((a, b) => {
        const t = a.type.localeCompare(b.type);
        if (t !== 0) return t;
        return (a.slug ?? "").localeCompare(b.slug ?? "");
      }),
    line_item_slugs: input.lineItems
      .map((li) => li.service_slug ?? null)
      .sort((a, b) => (a ?? "").localeCompare(b ?? "")),
    total_recovery_cents: Math.round(input.totalRecoveryEstimate * 100),
  };
  // Cost-Share v2 (Finding 4) — fold the cost-share basis in ONLY when present
  // (flag ON). Absent → `canonical` IS `base`, so the serialized JSON and the
  // resulting hash are byte-identical to the pre-Finding-4 fingerprint.
  const canonical = input.costShareBasis
    ? { ...base, cost_share_basis: canonicalizeCostShareBasis(input.costShareBasis) }
    : base;
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

/**
 * Compute cooldown_until value to write at Mark-as-Sent.
 * Defaults to 30 days per Q-M LOCK; configurable via flag in future.
 */
export function computeCooldownUntil(sentAt: Date, days: number = 30): Date {
  return new Date(sentAt.getTime() + days * 24 * 60 * 60 * 1000);
}

// ── Cost-Share v2 (W4) — letter version history ────────────────────────────
//
// W4 makes dispute letters persistent + NEVER background-updated: a GET serves
// the saved letter; regeneration happens ONLY on an explicit user refresh, and
// that refresh PRESERVES the prior letter so a user can revert (§13.4). The
// bounded history is stored under `dispute_outcomes.metadata.letterVersionHistory`
// — consistent with the route's existing large-snapshot-in-metadata pattern
// (`preBindCoverageSnapshot`), so no new column/table/migration.

export interface LetterVersion {
  /** the full prior letter body being superseded. */
  content: string;
  /** the evidence fingerprint that letter was built against (for provenance). */
  fingerprint: string | null;
  /** ISO timestamp when this version was superseded. */
  savedAt: string;
}

/**
 * Append a superseded letter onto the bounded version history (newest LAST),
 * capping at `cap` by dropping the oldest. Pure — the caller persists the result
 * into `metadata.letterVersionHistory`. A null/empty content is not stored (no
 * point versioning an absent letter).
 */
export function appendLetterVersion(
  history: LetterVersion[] | null | undefined,
  entry: LetterVersion,
  cap = 3,
): LetterVersion[] {
  const base = Array.isArray(history) ? history : [];
  if (!entry.content) return base;
  const next = [...base, entry];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * Decision shape for the view endpoint: should we refresh the letter, show a
 * drift banner, or serve cached?
 */
export type DriftDecision =
  | { action: "serve_cached" }
  | { action: "regenerate_draft"; reason: "fingerprint_mismatch" }
  | {
      action: "show_drift_banner_for_sent";
      cooldownActive: boolean;
      cooldownUntil: Date | null;
    }
  | { action: "serve_cached_within_debounce"; debounceSecondsRemaining: number };

export function decideDriftAction(opts: {
  storedFingerprint: string | null;
  currentFingerprint: string;
  sentAt: Date | null;
  cooldownUntil: Date | null;
  lastRefreshAt: Date | null;
  debounceMinutes?: number;
}): DriftDecision {
  const debounceMs = (opts.debounceMinutes ?? 5) * 60 * 1000;
  const isMatch = opts.storedFingerprint === opts.currentFingerprint;

  if (isMatch) return { action: "serve_cached" };

  // Mismatch path
  if (opts.sentAt) {
    const now = Date.now();
    const cooldownActive = opts.cooldownUntil
      ? now < opts.cooldownUntil.getTime()
      : false;
    return {
      action: "show_drift_banner_for_sent",
      cooldownActive,
      cooldownUntil: opts.cooldownUntil,
    };
  }

  // Mismatch + draft: debounce regenerate
  if (opts.lastRefreshAt) {
    const elapsed = Date.now() - opts.lastRefreshAt.getTime();
    if (elapsed < debounceMs) {
      return {
        action: "serve_cached_within_debounce",
        debounceSecondsRemaining: Math.ceil((debounceMs - elapsed) / 1000),
      };
    }
  }

  return { action: "regenerate_draft", reason: "fingerprint_mismatch" };
}
