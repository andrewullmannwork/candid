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
  getTimeDecayBracket,
  resolveTrustTier,
  TRUST_WEIGHT,
  type PromotionEvalResult,
  type TrustTier,
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
  /** Layer 3 promotion-evaluation outcome (present only on the FLAG-ON path). */
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
        })
        .eq("canonical_plan_id", input.canonicalPlanId)
        .eq("file_hash", input.fileHash);
      notes.push(`parse_weight_accumulated: ${current} → ${current + eWeight}`);
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
  const planDocType = toPlanDocType(input.docType);
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
