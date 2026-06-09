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
 *   - Layer 1 contribution gate (Ing-D.0b): only documents with
 *     `cf40_layer1_passed = TRUE` establish a plan's doc-type mapping, so ONLY
 *     Layer-1-passing parses count toward corroboration/supermajority/coverage
 *     (§2.2). NULL (parse predates the gate / recorded flag-off) + FALSE are
 *     excluded — forward-only; promotion builds from gated corroboration only.
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
import { type IdentityTuple, withinPlausibility } from "./invalidation";
import { upsertDivergenceReview, type DivergenceReviewRow } from "./divergence-review";
import { DEFAULT_CF40V4_CONFIG, type CF40V4Config } from "./config";

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

export type IdentityField = (typeof SUPERMAJORITY_IDENTITY_FIELDS)[number];

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

/**
 * Ing-D.0d — a non-baseline identity tuple from the Layer-3(b) supermajority vote.
 * The supermajority collapses the weight distribution to baseline + total; these are
 * the dissenting tuples v3 dropped and v4 routes to canonical_divergence_review.
 */
export interface MinorityCandidate {
  tuple: IdentityTuple;
  /** summed per-user effective weight for this tuple. */
  weight: number;
  /** the verified users whose latest upload voted this tuple. */
  userIds: string[];
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
  /** Ing-D.0d — the supermajority "winner" tuple (max-weight); null if no verified votes. */
  baselineTuple: IdentityTuple | null;
  /** Ing-D.0d — non-baseline tuples (the dropped minorities) for divergence routing. */
  minorities: MinorityCandidate[];
  /**
   * Ing-D.0d — canonical_plans.divergence_pending_verification. The minority router
   * is SKIPPED while this is TRUE: an open verification (Layer-4 §2.7c) owns the
   * canonical's divergence adjudication, so a parallel divergence_review row would be a
   * redundant cross-queue entry that the verification→re-baseline resolution could
   * stale. Set by the IO wrapper (gatherLayer3Inputs); the pure aggregation defaults
   * it false (it has no verification knowledge).
   */
  divergencePendingVerification: boolean;
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
export function computeLayer3Inputs(
  args: ComputeLayer3InputsArgs,
  cfg: CF40V4Config = DEFAULT_CF40V4_CONFIG,
): Layer3Inputs {
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
  const scaleTier = getScaleTier(uploadCount, cfg.scale);

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
  const tupleByKey = new Map<string, IdentityTuple>();
  const usersByKey = new Map<string, string[]>();
  let totalWeight = 0;
  for (const [userId, r] of latestByUser) {
    const t = trustOf(userId);
    if (!t) continue; // verified ⇒ present, but be defensive
    const tier: TrustTier = resolveTrustTier({
      isAdmin: t.isAdmin,
      phoneVerified: t.phoneVerified,
      emailVerified: t.emailVerified,
    });
    const w = effectiveWeight(tier, parseAgeDays(r.createdAt, now), cfg.weights);
    const key = identityKey(r.identityValues);
    weightByValue.set(key, (weightByValue.get(key) ?? 0) + w);
    if (!tupleByKey.has(key)) tupleByKey.set(key, r.identityValues);
    usersByKey.set(key, [...(usersByKey.get(key) ?? []), userId]);
    totalWeight += w;
  }
  // Baseline = the max-weight tuple (the supermajority "winner"). Ties resolve to the
  // first-seen winner — and the OTHER half surfaces as a minority, which is exactly the
  // 50/50 divergence we want admin to see (Ing-D.0d). NO outlier-elimination (the v3 sin).
  let baselineKey: string | null = null;
  let baselineWeight = 0;
  for (const [key, w] of weightByValue) {
    if (w > baselineWeight) {
      baselineWeight = w;
      baselineKey = key;
    }
  }
  const baselineTuple = baselineKey ? tupleByKey.get(baselineKey) ?? null : null;
  // Minorities (Ing-D.0d): every non-baseline tuple with weight > 0 — dropped by v3,
  // routed to canonical_divergence_review by v4 (routeMinorityCandidates).
  const minorities: MinorityCandidate[] = [];
  for (const [key, w] of weightByValue) {
    if (key === baselineKey) continue;
    const tuple = tupleByKey.get(key);
    if (!tuple) continue;
    minorities.push({ tuple, weight: w, userIds: usersByKey.get(key) ?? [] });
  }

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
    baselineTuple,
    minorities,
    // Pure default — the IO wrapper (gatherLayer3Inputs) sets the real canonical state.
    divergencePendingVerification: false,
  };
}

/**
 * Stable key for an identity-value tuple (NULLs distinguished from 0). Exported so
 * the ID-Block re-eval cron's tuple-drift guard (apply-confirmed-promotion.ts) can
 * compare the CURRENT supermajority winner against the held row's value_tuple_key —
 * which the gate produced with the identical field list/order (id-block/gate.ts
 * tupleKey ≡ this; locked by the cf40-v4/__fixtures__ tuple-key-parity fixture).
 */
export function identityKey(values: Record<IdentityField, number | null>): string {
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
  cfg: CF40V4Config = DEFAULT_CF40V4_CONFIG,
): { result: PromotionEvalResult; eventType: "pattern1_3_organic" | "admin_attested" } {
  let result = evaluateOrganicPromotion({
    corroboration: inputs.corroboration,
    supermajority: inputs.supermajority,
    coverage: inputs.coverage,
    uploadCount: inputs.uploadCount,
    scaleTier: inputs.scaleTier,
    docType,
  }, cfg);
  let eventType: "pattern1_3_organic" | "admin_attested" = "pattern1_3_organic";

  if (!result.promoted && adminAttestationEnabled && inputs.adminUploadCount >= cfg.adminAttestation.minUploadsPerDocType) {
    const adminResult = evaluateAdminAttestation({
      coverage: inputs.coverage,
      adminUploadCountPerDocType: inputs.adminUploadCount,
      docType,
    }, cfg);
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
  cfg: CF40V4Config = DEFAULT_CF40V4_CONFIG,
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
    .select("linked_insurance_plan_id, classified_type, cf40_layer1_passed")
    .in("linked_insurance_plan_id", planIds);
  const docTypeByPlanId = new Map<string, string>();
  for (const d of docs ?? []) {
    const pid = d.linked_insurance_plan_id as string | null;
    // CF-40 v4 Layer 1 contribution gate (Ing-D.0b): ONLY parses that PASSED
    // Layer 1 contribute to coverage/corroboration (Subplan §2.2 — "contributes
    // to stability counter AND coverage scoring ONLY IF all gates pass").
    // cf40_layer1_passed NULL (parse predates the gate / recorded flag-off) or
    // FALSE → the plan is excluded from `filtered` below and counts toward
    // nothing. Forward-only: promotion builds from gated corroboration only.
    if (pid && d.cf40_layer1_passed === true && !docTypeByPlanId.has(pid)) {
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

  // 4. canonical scale + verification state (one read; the verification flag gates
  //    the Ing-D.0d minority router — see Layer3Inputs.divergencePendingVerification).
  const { data: canonical } = await supabase
    .from("canonical_plans")
    .select("extraction_count, divergence_pending_verification")
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

  const inputs = computeLayer3Inputs({
    docType,
    planRows,
    userById,
    extractionCount,
    serviceCountByPlanId,
    verifiedServiceCount: verifiedServiceIds.size,
    now,
  }, cfg);
  return {
    ...inputs,
    divergencePendingVerification: canonical?.divergence_pending_verification === true,
  };
}

// ── Ing-D.0d — Layer 3(b) minority-candidate router ──────────────────────────

/** Per-field divergence of a minority tuple vs the baseline tuple. */
export interface MinorityFieldDiff {
  field: IdentityField;
  baselineValue: number | null;
  minorityValue: number | null;
}

/**
 * Decompose a minority tuple against the baseline into the fields that actually
 * differ. Pure. The supermajority votes per-TUPLE, but the admin queue + the
 * rapid-change writer are per-FIELD — so each differing field becomes its own row,
 * with the full co-occurring tuple preserved in the JSONB (the plan-variant-vs-noise
 * signal). Null is distinguished from 0 (a value→null transition IS a divergence).
 */
export function diffMinorityFields(
  baseline: IdentityTuple,
  minority: IdentityTuple,
): MinorityFieldDiff[] {
  const diffs: MinorityFieldDiff[] = [];
  for (const f of SUPERMAJORITY_IDENTITY_FIELDS) {
    if ((baseline[f] ?? null) !== (minority[f] ?? null)) {
      diffs.push({ field: f, baselineValue: baseline[f] ?? null, minorityValue: minority[f] ?? null });
    }
  }
  return diffs;
}

/**
 * PURE — the divergence-review rows the minority router would write for a
 * (canonical, doc_type) from its gathered Layer-3 inputs. Returns [] when there is no
 * split worth surfacing. Fixture-locked (Ship Gate G4); `routeMinorityCandidates` is
 * the thin IO wrapper that upserts these.
 *
 * Gates: a baseline + ≥1 minority tuple exists; ≥ cfg.minVerifiedUsers distinct
 * phone+email-verified users (no routing on a single-uploader canonical); per minority
 * weight > cfg.minMinorityWeight. Plausibility ([0.2×,5×] vs the baseline field value)
 * is STAMPED in the JSONB, NOT filtered — recall over precision; the admin queue is the
 * precision gate. A null↔value transition is not ratio-checkable → stamped implausible.
 */
export function buildMinorityReviewRows(
  canonicalPlanId: string,
  docType: PlanDocType,
  inputs: Layer3Inputs,
  cfg: CF40V4Config = DEFAULT_CF40V4_CONFIG,
): DivergenceReviewRow[] {
  if (!inputs.baselineTuple || inputs.minorities.length === 0) return [];
  if (inputs.corroboration.distinctPhoneEmailUsers < cfg.minorityRouter.minVerifiedUsers) return [];

  const rows: DivergenceReviewRow[] = [];
  for (const m of inputs.minorities) {
    if (m.weight <= cfg.minorityRouter.minMinorityWeight) continue;
    for (const d of diffMinorityFields(inputs.baselineTuple, m.tuple)) {
      const plausible =
        d.baselineValue != null && d.minorityValue != null
          ? withinPlausibility(
              d.minorityValue,
              d.baselineValue,
              cfg.plausibility.min,
              cfg.plausibility.max,
            )
          : false; // null↔value transition: not ratio-checkable → admin reviews
      rows.push({
        canonicalPlanId,
        documentType: docType,
        fieldName: d.field,
        minorityValueKey: d.minorityValue === null ? "∅" : String(d.minorityValue),
        minorityValueJsonb: {
          value: d.minorityValue,
          baseline_value: d.baselineValue,
          plausible,
          co_occurring_tuple: m.tuple,
          baseline_tuple: inputs.baselineTuple,
          source: "layer3b_minority",
        },
        minorityWeight: Number(m.weight.toFixed(3)),
        totalWeight: Number(inputs.supermajority.totalWeight.toFixed(3)),
        contributingUserIds: m.userIds,
        divergenceType: "unclassified",
      });
    }
  }
  return rows;
}

/**
 * Ing-D.0d — route Layer-3(b) minority candidates to canonical_divergence_review.
 * Thin IO wrapper over buildMinorityReviewRows + the shared idempotent upsert. The
 * caller (recordParseEventV4) gates this on FLAG-ON + planDocType + !inReBaselineMode
 * (the vote distribution is mid-rebuild while re-baselining → premature to route;
 * re-evaluated once the canonical re-promotes). Non-fatal.
 */
export async function routeMinorityCandidates(
  supabase: SupabaseClient,
  canonicalPlanId: string,
  docType: PlanDocType,
  inputs: Layer3Inputs,
  cfg: CF40V4Config = DEFAULT_CF40V4_CONFIG,
): Promise<{ routed: number; notes: string[] }> {
  const rows = buildMinorityReviewRows(canonicalPlanId, docType, inputs, cfg);
  if (rows.length === 0) return { routed: 0, notes: [] };
  let routed = 0;
  for (const row of rows) {
    const outcome = await upsertDivergenceReview(supabase, row);
    if (outcome !== "skipped") routed += 1;
  }
  return {
    routed,
    notes:
      routed > 0
        ? [`Layer 3(b): ${routed} minority field-divergence(s) → canonical_divergence_review`]
        : ["Layer 3(b): minority rows present but all upserts skipped (non-fatal)"],
  };
}
