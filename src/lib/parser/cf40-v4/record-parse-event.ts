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
  CF40_V4_FLAG_KEY,
  effectiveWeight,
  getTimeDecayBracket,
  resolveTrustTier,
  TRUST_WEIGHT,
  type TrustTier,
} from "./index";
import { isPlanDocumentType } from "@/lib/plan/extraction-dedup";
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
  // When v4 is enabled in production, this branch performs the actual
  // canonical_doctype_promotion_state + canonical_document_stability writes
  // for Layer 2 weight accumulation + Layer 3 promotion evaluation.
  //
  // For Session 80 close: this is intentionally a logging-only seam.
  // Mig 086 is not yet applied to PROD; full DB integration ships as
  // Phase 2 follow-up after the schema lands + admin smoke confirms.
  // See Subplan §8 closeout criterion #11.
  console.log(
    `[cf40-v4] FLAG ON — would record parse event. (canonical=${input.canonicalPlanId}, hash=${input.fileHash.slice(0, 12)}…, doc=${input.docType}, tier=${tier}, w=${eWeight}, age_days=${ageDays}, new_services=${input.newServicesFound}, baseline_match=${input.haikuPlanIdentityMatchesBaseline})`,
  );
  notes.push(
    "v4 flag ON: full integration deferred to Phase 2 follow-up (mig 086 + admin soak required first)",
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

  return {
    v4Enabled: true,
    decision: "recorded",
    trustTier: tier,
    effectiveWeight: eWeight,
    timeDecayBracket: bracket,
    trustWeight: TRUST_WEIGHT[tier],
    notes,
  };
}
