/**
 * CF-40 v4 (S73.5 D2c + D3) — Integration seam: parse-event recorder.
 *
 * Called from `recordExtractionResult` in `src/lib/plan/extraction-dedup.ts`
 * AFTER the existing v3 update to `canonical_document_stability`. When the
 * `cf40_v4_algorithm` flag is OFF (the default, the only state in PROD until
 * post-MVP empirical validation), this function is a no-op — v3 behavior is
 * preserved.
 *
 * When the flag is ON, this function:
 *   1. Increments `parse_weight_accumulated` on canonical_document_stability
 *      by effective_weight = trust_weight × time_decay_multiplier (Layer 2).
 *   2. Evaluates Layer 3 promotion criteria for (canonical, doc_type) and
 *      writes to `canonical_doctype_promotion_state` if criteria met.
 *   3. Telemetry: emits per-layer decision logs (Subplan §3 D3 deliverable).
 *
 * Currently a logging-only stub for telemetry observation in dev DB. Phase 2
 * follow-up wires the actual canonical_doctype_promotion_state writes once
 * mig 086 is applied to PROD + flag is flipped ON for admin users for soak
 * (per Subplan §8 closeout criterion #12 "cf40_v4_algorithm flag remains OFF
 * in PROD post-merge; flip post-MVP after telemetry validates").
 *
 * D4 (admin attestation overlay) — also flag-gated via
 * `admin_attestation_enabled` (default ON). Admin uploads ALWAYS full-parse
 * (Layer 5 trigger #1, enforced by `decideForcedReparse`). When admin uploads
 * accumulate to ≥2 per (canonical, doc_type) AND Layer 3(c) coverage holds,
 * `apply_admin_attested_promotion` writes promotion_event_type='admin_attested'.
 */

import type { createServerClient } from "@/lib/supabase/server";
import {
  ADMIN_ATTESTATION_FLAG_KEY,
  CF40_V4_FLAG_KEY,
  effectiveWeight,
  evaluateValidityGates,
  getTimeDecayBracket,
  resolveTrustTier,
  TRUST_WEIGHT,
  type PromotionEvalResult,
  type TrustTier,
  type ValidityGateFailure,
} from "./index";
import { decideDoctypePromotion, gatherLayer3Inputs } from "./doctype-promotion-aggregator";
import { isPlanDocumentType } from "@/lib/plan/extraction-dedup";
import { toPlanDocType, type PlanDocType } from "@/lib/parser/doctype-expected-counts";
import type { ClassifiedDocType } from "@/lib/classifier";

type SupabaseClient = ReturnType<typeof createServerClient>;

export interface ParseEventInput {
  canonicalPlanId: string;
  fileHash: string;
  documentId: string;
  userId: string;
  docType: ClassifiedDocType;
  uploadedAt: Date;
  uploaderIsAdmin: boolean;
  uploaderEmailVerified: boolean;
  uploaderPhoneVerified: boolean;
  uploaderEmail?: string;
  newServicesFound: number;
  haikuPlanIdentityMatchesBaseline: boolean;
  // ── Layer 1 validity-gate inputs (Ing-D.0b) ───────────────────────────────
  // Sourced at the parse caller (process-plan.ts). The doc-quality signals are
  // nullable — null = the parse path didn't produce that measurement, so the
  // gate is inapplicable (see ValidityGateInput). re_baseline_required is read
  // canonical-side here in the recorder (per-doc-type promotion state).
  selfCheckPassRate: number | null;
  ocrConfidence: number | null;
  classificationConfidence: number | null;
  fileSizeBytes: number;
  documentPlanYear: number | null;
  uploaderIsBanned: boolean;
}

/**
 * Record a parse event under the v4 algorithm. No-op if the v4 flag is OFF.
 *
 * Returns a structured telemetry payload (always — even when flag OFF) so
 * callers can log per-event observations during the soak period. The payload
 * is also written to `parse_audit_runs` (existing JSONB sink) when the v4
 * flag is ON — see D3 telemetry deliverable.
 */
export interface ParseEventTelemetry {
  v4Enabled: boolean;
  decision: "skipped_flag_off" | "skipped_not_plan_doc" | "recorded";
  trustTier: TrustTier;
  effectiveWeight: number;
  timeDecayBracket: ReturnType<typeof getTimeDecayBracket>;
  trustWeight: number;
  notes: string[];
  /** Layer 1 validity-gate verdict (present only on the FLAG-ON path). When
   * `pass` is false, the parse contributed NO Layer 2 weight + NO Layer 3
   * coverage/corroboration (§2.2) and `documents.cf40_layer1_passed` was set
   * FALSE. */
  layer1?: {
    evaluated: boolean;
    pass: boolean;
    failureReasons: ValidityGateFailure[];
  };
  /** Layer 3 promotion-evaluation outcome (present only on the FLAG-ON path AND
   * only when Layer 1 passed — a failed parse never reaches Layer 3). */
  promotion?: {
    evaluated: boolean;
    promoted: boolean;
    eventType: "pattern1_3_organic" | "admin_attested" | null;
    coverageScore: number;
    distinctUsers: number;
  };
}

export async function recordParseEventV4(
  supabase: SupabaseClient,
  input: ParseEventInput,
): Promise<ParseEventTelemetry> {
  const notes: string[] = [];

  // Plan-doc-only structural guard (D1 invariant). v4 only operates on plan
  // documents — bills/EOBs/cards never reach here in practice but the guard
  // makes the invariant explicit.
  if (!isPlanDocumentType(input.docType)) {
    return {
      v4Enabled: false,
      decision: "skipped_not_plan_doc",
      trustTier: "unverified",
      effectiveWeight: 0,
      timeDecayBracket: "0_90d",
      trustWeight: 0,
      notes: [`docType=${input.docType} not in plan-document whitelist`],
    };
  }

  // Flag check — when OFF (default), short-circuit with telemetry only.
  let v4Enabled = false;
  try {
    const { isFeatureEnabled } = await import("@/lib/config/product-flags");
    v4Enabled = await isFeatureEnabled(CF40_V4_FLAG_KEY, input.uploaderEmail);
  } catch (err) {
    notes.push(`flag check failed (non-fatal): ${err instanceof Error ? err.message : err}`);
  }

  // Resolve trust + time-decay (always computed for telemetry).
  const tier = resolveTrustTier({
    isAdmin: input.uploaderIsAdmin,
    phoneVerified: input.uploaderPhoneVerified,
    emailVerified: input.uploaderEmailVerified,
  });
  const ageMs = Date.now() - input.uploadedAt.getTime();
  const ageDays = Math.max(0, Math.floor(ageMs / (1000 * 60 * 60 * 24)));
  const bracket = getTimeDecayBracket(ageDays);
  const eWeight = effectiveWeight(tier, ageDays);

  if (!v4Enabled) {
    console.log(
      `[cf40-v4] FLAG OFF — telemetry only. (canonical=${input.canonicalPlanId}, hash=${input.fileHash.slice(0, 12)}…, doc=${input.docType}, tier=${tier}, w=${eWeight}, age_days=${ageDays})`,
    );
    return {
      v4Enabled: false,
      decision: "skipped_flag_off",
      trustTier: tier,
      effectiveWeight: eWeight,
      timeDecayBracket: bracket,
      trustWeight: TRUST_WEIGHT[tier],
      notes,
    };
  }

  // ── FLAG ON path ──────────────────────────────────────────────────────────
  // Ing-D.0a (mig 086 PROD-applied): Layer 2 weight accumulation +
  // Layer 3 per-(canonical, doc_type) promotion evaluation + UPSERT into
  // canonical_doctype_promotion_state. This branch only runs when
  // cf40_v4_algorithm is ON — dormant in PROD until Ing-D.1 flips the flag.
  console.log(
    `[cf40-v4] FLAG ON — recording parse event. (canonical=${input.canonicalPlanId}, hash=${input.fileHash.slice(0, 12)}…, doc=${input.docType}, tier=${tier}, w=${eWeight}, age_days=${ageDays}, new_services=${input.newServicesFound}, baseline_match=${input.haikuPlanIdentityMatchesBaseline})`,
  );

  // ── Layer 1 — validity-gate contribution gate (Ing-D.0b) ────────────────────
  // Per Subplan §2.2: a parse contributes to Layer 2 stability AND Layer 3
  // coverage/corroboration ONLY IF all validity gates pass. Evaluate Layer 1 now
  // (the parse just ran; quality signals exist), record the verdict on the
  // document so the Layer 3 aggregator can EXCLUDE failed parses, and — on
  // failure — skip BOTH the weight increment AND the promotion evaluation below.
  const planDocType = toPlanDocType(input.docType);
  let layer1Pass = true;
  let layer1Failures: ValidityGateFailure[] = [];
  if (planDocType) {
    try {
      const canonicalReBaselineRequired = await readReBaselineRequired(
        supabase,
        input.canonicalPlanId,
        planDocType,
      );
      const validity = evaluateValidityGates({
        selfCheckPassRate: input.selfCheckPassRate,
        ocrConfidence: input.ocrConfidence,
        classificationConfidence: input.classificationConfidence,
        uploadedAt: input.uploadedAt,
        documentPlanYear: input.documentPlanYear,
        fileSizeBytes: input.fileSizeBytes,
        docType: planDocType,
        uploaderTier: tier,
        isAdmin: input.uploaderIsAdmin,
        isBanned: input.uploaderIsBanned,
        canonicalReBaselineRequired,
      });
      layer1Pass = validity.pass;
      layer1Failures = validity.failureReasons;
    } catch (err) {
      // Conservative on error: do NOT contribute (treat as fail) so weight never
      // accrues from an un-validated parse. v3 stability (caller) already persisted.
      // failureReasons left empty — this is an evaluation error, not a specific
      // gate verdict; the note carries the diagnostic.
      layer1Pass = false;
      layer1Failures = [];
      console.warn("[cf40-v4] Layer 1 evaluation error (non-fatal) → not contributing:", err);
      notes.push("Layer 1 evaluation error (non-fatal) → treated as not-contributing");
    }
  }

  // Record the per-parse verdict on the document (non-fatal). TRUE + FALSE are
  // both written; NULL is reserved for parses never Layer-1-evaluated (pre-flag /
  // flag-off), which the aggregator also excludes.
  try {
    await supabase
      .from("documents")
      .update({ cf40_layer1_passed: layer1Pass })
      .eq("id", input.documentId);
  } catch (err) {
    console.warn("[cf40-v4] cf40_layer1_passed write failed (non-fatal):", err);
    notes.push("cf40_layer1_passed write skipped (non-fatal error)");
  }

  if (!layer1Pass) {
    notes.push(
      `Layer 1 FAILED (${layer1Failures.join(", ") || "evaluation_error"}) — NO Layer 2 weight, NO Layer 3 contribution`,
    );
    return {
      v4Enabled: true,
      decision: "recorded",
      trustTier: tier,
      effectiveWeight: eWeight,
      timeDecayBracket: bracket,
      trustWeight: TRUST_WEIGHT[tier],
      notes,
      layer1: { evaluated: true, pass: false, failureReasons: layer1Failures },
    };
  }

  // Optional: bump parse_weight_accumulated (additive, safe even if v4 path
  // is partially wired). Wrapped in try/catch so any schema-missing case fails
  // gracefully and v3 path continues.
  try {
    const { data: stability } = await supabase
      .from("canonical_document_stability")
      .select("parse_weight_accumulated")
      .eq("canonical_plan_id", input.canonicalPlanId)
      .eq("file_hash", input.fileHash)
      .maybeSingle();

    if (stability) {
      const current = (stability.parse_weight_accumulated as number | null) ?? 0;
      await supabase
        .from("canonical_document_stability")
        .update({
          parse_weight_accumulated: current + eWeight,
          // Layer 5 temporal-staleness counter: record this Layer-1-passing full
          // parse as the last full parse of this (canonical, hash) so
          // decideForcedReparse can fire on staleness. Set here (not on the fail
          // path) so the clock resets only on a GOOD full parse.
          last_full_parse_at: new Date().toISOString(),
        })
        .eq("canonical_plan_id", input.canonicalPlanId)
        .eq("file_hash", input.fileHash);
      notes.push(`parse_weight_accumulated: ${current} → ${current + eWeight}; last_full_parse_at refreshed`);
    }
  } catch (err) {
    // Non-fatal — v3 behavior already executed at caller; v4 enrichment is best-effort.
    console.warn("[cf40-v4] parse_weight_accumulated update failed (non-fatal):", err);
    notes.push(`weight accumulation skipped (non-fatal error)`);
  }

  // ── Layer 3 — per-(canonical, doc_type) promotion evaluation (Ing-D.0a) ─────
  // Gather corroboration + supermajority + coverage from the user-side flywheel
  // tables, run the promotion evaluator, and UPSERT canonical_doctype_promotion_state.
  // Organic Pattern 1 #3 first; admin-attested fallback when organic doesn't pass
  // (gated on admin_attestation_enabled + ≥2 admin uploads). Non-fatal — any failure
  // here must not break v3 stability persistence (already done above).
  let promotion: ParseEventTelemetry["promotion"] = {
    evaluated: false,
    promoted: false,
    eventType: null,
    coverageScore: 0,
    distinctUsers: 0,
  };
  if (planDocType) {
    try {
      const inputs = await gatherLayer3Inputs(
        supabase,
        input.canonicalPlanId,
        planDocType,
        new Date(),
      );
      if (inputs) {
        // Admin-attested fallback is flag-gated — resolve the flag (IO) before the
        // pure decision (decideDoctypePromotion). Default OFF on flag-read error.
        let adminEnabled = false;
        try {
          const { isFeatureEnabled } = await import("@/lib/config/product-flags");
          adminEnabled = await isFeatureEnabled(ADMIN_ATTESTATION_FLAG_KEY, input.uploaderEmail);
        } catch {
          // default OFF — no admin promotion
        }

        const { result, eventType } = decideDoctypePromotion(inputs, planDocType, adminEnabled);

        await upsertDoctypePromotionState(
          supabase,
          input.canonicalPlanId,
          planDocType,
          result,
          eventType,
        );

        promotion = {
          evaluated: true,
          promoted: result.promoted,
          eventType: result.promoted ? eventType : null,
          coverageScore: result.observed.coverageScore,
          distinctUsers: result.observed.distinctUsers,
        };
        notes.push(
          result.promoted
            ? `Layer 3: PROMOTED (${eventType}) doc_type=${planDocType} coverage=${result.observed.coverageScore.toFixed(3)}`
            : `Layer 3: not promoted (${result.failureReasons.join(", ") || "criteria unmet"})`,
        );
      } else {
        notes.push(`Layer 3: no user-side uploads of doc_type=${planDocType} — skipped`);
      }
    } catch (err) {
      // Non-fatal — v3 stability already persisted; v4 Layer 3 is best-effort.
      console.warn("[cf40-v4] Layer 3 evaluation failed (non-fatal):", err);
      notes.push("Layer 3 evaluation skipped (non-fatal error)");
    }
  }

  return {
    v4Enabled: true,
    decision: "recorded",
    trustTier: tier,
    effectiveWeight: eWeight,
    timeDecayBracket: bracket,
    trustWeight: TRUST_WEIGHT[tier],
    notes,
    layer1: { evaluated: true, pass: true, failureReasons: [] },
    promotion,
  };
}

/**
 * UPSERT the Layer 3 verdict into canonical_doctype_promotion_state.
 *
 * Sticky promotion (Ing-D.0a critical review): once `doctype_promoted=TRUE`, it
 * stays TRUE — a later weaker parse never auto-demotes. Layer 4 (Ing-D.0c) owns
 * demotion via `re_baseline_required`, which this UPSERT never writes (omitted →
 * preserved on conflict; default FALSE on insert). `promotion_event_type` and
 * `promoted_at` are set ONCE, on first promotion. coverage_score / counts /
 * last_evaluated_at refresh on every evaluation.
 */
async function upsertDoctypePromotionState(
  supabase: SupabaseClient,
  canonicalPlanId: string,
  docType: PlanDocType,
  result: PromotionEvalResult,
  eventType: "pattern1_3_organic" | "admin_attested",
): Promise<void> {
  const nowIso = new Date().toISOString();

  const { data: existing } = await supabase
    .from("canonical_doctype_promotion_state")
    .select("doctype_promoted, promotion_event_type, promoted_at")
    .eq("canonical_plan_id", canonicalPlanId)
    .eq("document_type", docType)
    .maybeSingle();

  const wasPromoted = existing?.doctype_promoted === true;
  const nowPromoted = wasPromoted || result.promoted; // sticky

  const promotionEventType = wasPromoted
    ? ((existing?.promotion_event_type as string | null) ?? null)
    : result.promoted
      ? eventType
      : null;
  const promotedAt = wasPromoted
    ? ((existing?.promoted_at as string | null) ?? null)
    : result.promoted
      ? nowIso
      : null;

  await supabase.from("canonical_doctype_promotion_state").upsert(
    {
      canonical_plan_id: canonicalPlanId,
      document_type: docType,
      doctype_promoted: nowPromoted,
      promotion_event_type: promotionEventType,
      promoted_at: promotedAt,
      coverage_score: round3(result.observed.coverageScore),
      distinct_users_count: result.observed.distinctUsers,
      total_qualifying_uploads: result.observed.totalUploads,
      last_evaluated_at: nowIso,
      // re_baseline_required intentionally omitted — Layer 4 (Ing-D.0c) owns it.
    },
    { onConflict: "canonical_plan_id,document_type" },
  );
}

/** Round to NUMERIC(4,3) precision for coverage_score storage. */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Read the per-doc-type re_baseline_required flag (Layer 4 → Layer 1 input).
 * Layer 4 (Ing-D.0c) sets this TRUE on slow-drift / rapid-change invalidation;
 * until then it is FALSE for every (canonical, doc_type). Missing row → FALSE
 * (no promotion state yet ⇒ nothing to re-baseline). Defaults FALSE on any
 * error so a transient read failure never blocks contribution.
 */
async function readReBaselineRequired(
  supabase: SupabaseClient,
  canonicalPlanId: string,
  docType: PlanDocType,
): Promise<boolean> {
  try {
    const { data } = await supabase
      .from("canonical_doctype_promotion_state")
      .select("re_baseline_required")
      .eq("canonical_plan_id", canonicalPlanId)
      .eq("document_type", docType)
      .maybeSingle();
    return data?.re_baseline_required === true;
  } catch {
    return false;
  }
}
