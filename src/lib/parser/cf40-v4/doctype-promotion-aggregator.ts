/**
 * CF-40 v4 (Ing-D.0a) — Layer 3 promotion-input aggregator.
 *
 * The Layer 3 evaluators (`evaluateOrganicPromotion` / `evaluateAdminAttestation`
 * in promotion-evaluator.ts) are pure functions over three criteria —
 * corroboration, supermajority, coverage. This module GATHERS those criteria for
 * a (canonical, doc_type) pair from the user-side flywheel tables.
 *
 * Split into two pieces so the aggregation is testable without a DB:
 *   - `computeLayer3Inputs(...)` — PURE. Aggregates already-fetched rows into the
 *     evaluator's criteria. The trust × time-decay weighting itself lives in
 *     trust-weight.ts (`effectiveWeight`) — the single source of truth; this module
 *     only groups + sums. Unit-testable with seeded data (Ship Gate G4).
 *   - `gatherLayer3Inputs(...)` — thin IO wrapper: runs the targeted queries, then
 *     delegates to `computeLayer3Inputs`.
 *
 * Design notes (Ing-D.0a critical review):
 *   - doc_type attribution uses `documents.classified_type` (the TRUE type), NOT
 *     the in-memory classification arg — `unified_plan_doc_parser_v1` coerces that
 *     to 'plan_document' for SBC/EOC/plan_document alike (process-chunk:502). The
 *     caller resolves the true type from the DB document row and passes it here.
 *   - Corroboration counts ONLY email+phone-verified users (Pattern 1 #15; mirrors
 *     mig 076's gate on `evaluate_pattern1_corroboration`). Admin uploads feed the
 *     SEPARATE admin-attested path, never organic corroboration.
 *   - Supermajority weights PER DISTINCT VERIFIED USER (latest upload), mirroring
 *     the corroboration RPC's `DISTINCT ON (user_id)` — a prolific uploader cannot
 *     inflate the share.
 *   - Diversity (IP/ASN/email-domain) is NOT collected today → passed undefined.
 *     `evaluateCorroboration` skips it at cold_start/small (thresholds null) and
 *     fail-closes at medium+ (safe). Deferred-telemetry follow-up.
 *   - Coverage "verified" = `field_provenance[field].source_excerpt_verified ===
 *     'verified'`, mirroring `evaluate_pattern1_corroboration`. EOC plan-identity
 *     (regex, no Pattern P-8) therefore contributes lower verified-scalar coverage
 *     by construction — a known characteristic to calibrate at Ing-D.1.
 */

import type { createServerClient } from "@/lib/supabase/server";
import {
  type CorroborationCriterion,
  type CoverageCriterion,
  type PromotionEvalResult,
  type ScaleTier,
  type SupermajorityCriterion,
  type TrustTier,
  getScaleTier,
} from "./types";
import { effectiveWeight, parseAgeDays, resolveTrustTier } from "./trust-weight";
import { evaluateAdminAttestation, evaluateOrganicPromotion } from "./promotion-evaluator";
import {
  DOC_TYPE_COVERAGE_CONFIG,
  type PlanDocType,
} from "@/lib/parser/doctype-expected-counts";

type SupabaseClient = ReturnType<typeof createServerClient>;

/**
 * Plan-identity cost scalars that define a parse's "identity value" for
 * supermajority grouping. Mirrors the CF-40 v3 stability tuple
 * (HaikuPlanIdentityValues in extraction-dedup.ts) so the supermajority votes on
 * the same value that drives per-hash stability.
 */
const SUPERMAJORITY_IDENTITY_FIELDS = [
  "in_deductible_individual",
  "in_deductible_family",
  "in_oop_max_individual",
  "in_oop_max_family",
] as const;

type IdentityField = (typeof SUPERMAJORITY_IDENTITY_FIELDS)[number];

/** Per-field provenance entry subset we care about (verified signal only). */
type ProvenanceMap = Record<string, { source_excerpt_verified?: string } | undefined> | null;

export interface AggUserTrust {
  isAdmin: boolean;
  emailVerified: boolean;
  phoneVerified: boolean;
}

export interface AggPlanRow {
  /** insurance_plans.id */
  planId: string;
  /** users.id (UUID) of the uploader */
  userId: string;
  /** insurance_plans.created_at (ISO) — proxy for parse/upload time */
  createdAt: string;
  /** field_provenance JSONB (per-field { source_excerpt_verified, ... }) */
  fieldProvenance: ProvenanceMap;
  /** the four plan-identity scalars (typed columns) for supermajority grouping */
  identityValues: Record<IdentityField, number | null>;
}

export interface Layer3Inputs {
  corroboration: CorroborationCriterion;
  supermajority: SupermajorityCriterion;
  coverage: CoverageCriterion;
  /** canonical lifetime upload_count → scale tier */
  uploadCount: number;
  scaleTier: ScaleTier;
  /** admin uploads of this doc_type for the canonical (admin-attested path gate) */
  adminUploadCount: number;
}

export interface ComputeLayer3InputsArgs {
  docType: PlanDocType;
  /** insurance_plans rows for (canonical, doc_type), already doc-type-filtered */
  planRows: AggPlanRow[];
  /** users.id → trust signals */
  userById: Map<string, AggUserTrust>;
  /** canonical_plans.extraction_count (lifetime) → scale tier */
  extractionCount: number;
  /** observed service counts per upload (plan_covered_services rows per planId) */
  serviceCountByPlanId: Map<string, number>;
  /** count of DISTINCT verified service slugs across these uploads (coverage) */
  verifiedServiceCount: number;
  /** evaluation timestamp (injectable for tests) */
  now: Date;
}

// ── PURE aggregation ─────────────────────────────────────────────────────────

/**
 * Aggregate already-fetched user-side rows into the Layer 3 evaluator criteria.
 * Pure — no IO. The trust × time-decay weighting is delegated to
 * `effectiveWeight` (trust-weight.ts) so there is one source of truth for the
 * weight constants.
 */
export function computeLayer3Inputs(args: ComputeLayer3InputsArgs): Layer3Inputs {
  const {
    docType,
    planRows,
    userById,
    extractionCount,
    serviceCountByPlanId,
    verifiedServiceCount,
    now,
  } = args;

  const uploadCount = extractionCount;
  const scaleTier = getScaleTier(uploadCount);

  const trustOf = (userId: string): AggUserTrust | undefined => userById.get(userId);
  // Pattern 1 #15 (mig 076): organic corroboration counts ONLY email+phone-verified.
  const isVerified = (t: AggUserTrust | undefined): boolean =>
    !!t && t.emailVerified && t.phoneVerified;

  const verifiedRows = planRows.filter((r) => isVerified(trustOf(r.userId)));
  const adminRows = planRows.filter((r) => trustOf(r.userId)?.isAdmin === true);

  // ── Corroboration (Layer 3a) ───────────────────────────────────────────────
  const verifiedUserIds = new Set(verifiedRows.map((r) => r.userId));
  const distinctPhoneEmailUsers = verifiedUserIds.size;
  const totalQualifyingUploads = verifiedRows.length;

  const dayKeys = new Set(
    verifiedRows.map((r) => new Date(r.createdAt).toISOString().slice(0, 10)),
  );
  const distinctCalendarDays = dayKeys.size;

  let timeSpanDays = 0;
  if (verifiedRows.length >= 2) {
    const times = verifiedRows.map((r) => new Date(r.createdAt).getTime());
    timeSpanDays = Math.floor((Math.max(...times) - Math.min(...times)) / 86_400_000);
  }

  const corroboration: CorroborationCriterion = {
    distinctPhoneEmailUsers,
    totalQualifyingUploads,
    distinctCalendarDays,
    timeSpanDays,
    highVolumeDistinctUsers: distinctPhoneEmailUsers,
    // diversity (ipBlockDiversity / asnDiversity / emailDomainDiversity) left
    // undefined — not collected; evaluateCorroboration skips it at cold_start/
    // small (thresholds null) and fail-closes at medium+ (safe). Deferred.
  };

  // ── Supermajority (Layer 3b) — per DISTINCT verified user (latest), weighted ─
  const latestByUser = new Map<string, AggPlanRow>();
  for (const r of verifiedRows) {
    const prev = latestByUser.get(r.userId);
    if (!prev || new Date(r.createdAt).getTime() > new Date(prev.createdAt).getTime()) {
      latestByUser.set(r.userId, r);
    }
  }
  const weightByValue = new Map<string, number>();
  let totalWeight = 0;
  for (const [userId, r] of latestByUser) {
    const t = trustOf(userId);
    if (!t) continue; // verified ⇒ present, but be defensive
    const tier: TrustTier = resolveTrustTier({
      isAdmin: t.isAdmin,
      phoneVerified: t.phoneVerified,
      emailVerified: t.emailVerified,
    });
    const w = effectiveWeight(tier, parseAgeDays(r.createdAt, now));
    const key = identityKey(r.identityValues);
    weightByValue.set(key, (weightByValue.get(key) ?? 0) + w);
    totalWeight += w;
  }
  let baselineWeight = 0;
  for (const w of weightByValue.values()) baselineWeight = Math.max(baselineWeight, w);

  const supermajority: SupermajorityCriterion = { baselineWeight, totalWeight };

  // ── Coverage (Layer 3c) ─────────────────────────────────────────────────────
  // verifiedScalarCount: of the doc-type's expected plan-identity scalars, how
  // many have ≥1 verified provenance across these uploads. verifiedServiceCount
  // is supplied by the caller (distinct verified service slugs).
  const expectedScalars = DOC_TYPE_COVERAGE_CONFIG[docType].expectedPlanIdentityScalars;
  let verifiedScalarCount = 0;
  for (const scalar of expectedScalars) {
    if (planRows.some((r) => isFieldVerified(r.fieldProvenance, scalar))) {
      verifiedScalarCount += 1;
    }
  }
  const observedServiceCounts = planRows
    .map((r) => serviceCountByPlanId.get(r.planId) ?? 0)
    .filter((n) => n > 0);

  const coverage: CoverageCriterion = {
    verifiedScalarCount,
    verifiedServiceCount,
    observedServiceCounts,
  };

  return {
    corroboration,
    supermajority,
    coverage,
    uploadCount,
    scaleTier,
    adminUploadCount: adminRows.length,
  };
}

/** Stable key for an identity-value tuple (NULLs distinguished from 0). */
function identityKey(values: Record<IdentityField, number | null>): string {
  return SUPERMAJORITY_IDENTITY_FIELDS.map((f) => (values[f] === null ? "∅" : String(values[f]))).join(
    "|",
  );
}

/**
 * A scalar counts as verified-from-this-doc when its provenance entry is
 * `source_excerpt_verified === 'verified'` (mirrors `evaluate_pattern1_corroboration`).
 * Checks both prefix variants (plan_doc writes `in_`; legacy SBC unprefixed).
 */
function isFieldVerified(fp: ProvenanceMap, field: string): boolean {
  if (!fp) return false;
  const variants = field.startsWith("in_") ? [field, field.slice(3)] : [field, `in_${field}`];
  return variants.some((k) => fp[k]?.source_excerpt_verified === "verified");
}

function provenanceHasAnyVerified(fp: ProvenanceMap): boolean {
  if (!fp) return false;
  return Object.values(fp).some((e) => e?.source_excerpt_verified === "verified");
}

/**
 * Decide a (canonical, doc_type) promotion from gathered inputs. Pure.
 *
 * Organic Pattern 1 #3 first; admin-attested fallback only when organic doesn't
 * pass AND admin attestation is enabled AND there are ≥2 admin uploads of this
 * doc_type (coverage is still required — see `evaluateAdminAttestation`). Returns
 * the winning evaluator result + the event_type that produced it; `eventType` is
 * meaningful only when `result.promoted` is true.
 */
export function decideDoctypePromotion(
  inputs: Layer3Inputs,
  docType: PlanDocType,
  adminAttestationEnabled: boolean,
): { result: PromotionEvalResult; eventType: "pattern1_3_organic" | "admin_attested" } {
  let result = evaluateOrganicPromotion({
    corroboration: inputs.corroboration,
    supermajority: inputs.supermajority,
    coverage: inputs.coverage,
    uploadCount: inputs.uploadCount,
    scaleTier: inputs.scaleTier,
    docType,
  });
  let eventType: "pattern1_3_organic" | "admin_attested" = "pattern1_3_organic";

  if (!result.promoted && adminAttestationEnabled && inputs.adminUploadCount >= 2) {
    const adminResult = evaluateAdminAttestation({
      coverage: inputs.coverage,
      adminUploadCountPerDocType: inputs.adminUploadCount,
      docType,
    });
    if (adminResult.promoted) {
      result = adminResult;
      eventType = "admin_attested";
    }
  }

  return { result, eventType };
}

// ── IO wrapper ────────────────────────────────────────────────────────────────

/**
 * Gather Layer 3 evaluator inputs for a (canonical, doc_type) pair via targeted
 * queries, then delegate to `computeLayer3Inputs`. Returns null when there are no
 * user-side uploads of this doc_type for the canonical (nothing to evaluate).
 *
 * doc_type is filtered via `documents.classified_type` (the TRUE type — see module
 * header) joined through `documents.linked_insurance_plan_id → insurance_plans.id`.
 */
export async function gatherLayer3Inputs(
  supabase: SupabaseClient,
  canonicalPlanId: string,
  docType: PlanDocType,
  now: Date,
): Promise<Layer3Inputs | null> {
  // 1. All insurance_plans rows for the canonical.
  const { data: planRowsRaw } = await supabase
    .from("insurance_plans")
    .select(
      "id, user_id, created_at, field_provenance, in_deductible_individual, in_deductible_family, in_oop_max_individual, in_oop_max_family",
    )
    .eq("canonical_plan_id", canonicalPlanId);
  if (!planRowsRaw || planRowsRaw.length === 0) return null;

  const planIds = planRowsRaw.map((r) => r.id as string);

  // 2. documents → doc_type per insurance_plan (TRUE type from the DB column,
  //    not the coerced in-memory classification).
  const { data: docs } = await supabase
    .from("documents")
    .select("linked_insurance_plan_id, classified_type")
    .in("linked_insurance_plan_id", planIds);
  const docTypeByPlanId = new Map<string, string>();
  for (const d of docs ?? []) {
    const pid = d.linked_insurance_plan_id as string | null;
    if (pid && !docTypeByPlanId.has(pid)) {
      docTypeByPlanId.set(pid, d.classified_type as string);
    }
  }

  const filtered = planRowsRaw.filter((r) => docTypeByPlanId.get(r.id as string) === docType);
  if (filtered.length === 0) return null;

  // 3. users trust signals.
  const userIds = [...new Set(filtered.map((r) => r.user_id as string))];
  const { data: users } = await supabase
    .from("users")
    .select("id, is_admin, email_verified, phone_verified")
    .in("id", userIds);
  const userById = new Map<string, AggUserTrust>();
  for (const u of users ?? []) {
    userById.set(u.id as string, {
      isAdmin: u.is_admin === true,
      emailVerified: u.email_verified === true,
      phoneVerified: u.phone_verified === true,
    });
  }

  // 4. canonical scale.
  const { data: canonical } = await supabase
    .from("canonical_plans")
    .select("extraction_count")
    .eq("id", canonicalPlanId)
    .maybeSingle();
  const extractionCount = (canonical?.extraction_count as number | null) ?? filtered.length;

  // 5. coverage service signals — plan_covered_services for the filtered plans.
  const filteredPlanIds = filtered.map((r) => r.id as string);
  const { data: pcsRows } = await supabase
    .from("plan_covered_services")
    .select("insurance_plan_id, service_id, field_provenance")
    .in("insurance_plan_id", filteredPlanIds);
  const serviceCountByPlanId = new Map<string, number>();
  const verifiedServiceIds = new Set<string>();
  for (const row of pcsRows ?? []) {
    const pid = row.insurance_plan_id as string;
    serviceCountByPlanId.set(pid, (serviceCountByPlanId.get(pid) ?? 0) + 1);
    if (provenanceHasAnyVerified(row.field_provenance as ProvenanceMap)) {
      verifiedServiceIds.add(row.service_id as string);
    }
  }

  const planRows: AggPlanRow[] = filtered.map((r) => ({
    planId: r.id as string,
    userId: r.user_id as string,
    createdAt: r.created_at as string,
    fieldProvenance: (r.field_provenance ?? null) as ProvenanceMap,
    identityValues: {
      in_deductible_individual: (r.in_deductible_individual as number | null) ?? null,
      in_deductible_family: (r.in_deductible_family as number | null) ?? null,
      in_oop_max_individual: (r.in_oop_max_individual as number | null) ?? null,
      in_oop_max_family: (r.in_oop_max_family as number | null) ?? null,
    },
  }));

  return computeLayer3Inputs({
    docType,
    planRows,
    userById,
    extractionCount,
    serviceCountByPlanId,
    verifiedServiceCount: verifiedServiceIds.size,
    now,
  });
}
