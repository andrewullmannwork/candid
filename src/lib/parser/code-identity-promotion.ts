// S74.5 D3 — Pattern 1 #3 promotion evaluator for billing-code mappings.
//
// Per plans/s74.5_categorization_flywheel.md v2 §6 + Q2 LOCK (fixed threshold 3) +
// Q4 LOCK (event log mirrors canonical_promotion_events) + G4 LOCK (sticky
// per-account user_correction_locked_at).
//
// Exports:
//   - recordUserCorrection() — user clicks "confirm" in correction modal (D5 endpoint)
//   - evaluateMappingPromotion() — Pattern 1 #3 evaluator; fires after each correction
//   - backfillCorroboratedMapping() — propagate promoted slug to peer rows
//   - getConflictedUsersForIdentity() — surface to D6 conflict modal flow
//   - isUserFullyVerified() — Pattern 1 #15 gate helper

import { createServerClient } from "../supabase/server";
import {
  lookupExactSignature,
  proposeNewSignature,
  normalizeDescriptionSignature,
} from "./code-identity";
import { inferProcedureCodeType } from "../billing/code-type-inference";
import type { ProcedureCodeType } from "../billing/types";
import * as crypto from "crypto";

const DEFAULT_PROMOTION_THRESHOLD = 3;
const DEFAULT_MAX_SOURCES = 5;

// ============================================================================
// Pattern 1 #15 verification gate
// ============================================================================

export async function isUserFullyVerified(userId: string): Promise<boolean> {
  if (!userId) return false;
  const supabase = createServerClient();
  const { data } = await supabase
    .from("users")
    .select("email_verified, phone_verified")
    .eq("id", userId)
    .maybeSingle();
  if (!data) return false;
  return Boolean(data.email_verified) && Boolean(data.phone_verified);
}

// ============================================================================
// Identity row mutation (race-tolerant: append-to-sources, dedup by user hash)
// ============================================================================

interface SourceEntry {
  user_id_hash: string;
  raw_description: string;
  claim_line_item_id: string;
  recorded_at: string;
}

function hashUserForIdentity(userId: string, identityId: string): string {
  // Stable per (user, identity) — same user submitting same identity twice
  // collapses to one source entry. Cross-identity reuse would re-hash.
  return crypto
    .createHash("sha256")
    .update(`${userId}:${identityId}`)
    .digest("hex");
}

interface UpsertCorrectorResult {
  identityId: string;
  isNewContributor: boolean;
  distinctUserCount: number;
  servedSlug: string | null;
  currentPromotionState: "proposed" | "corroborated" | "admin_verified";
}

/**
 * Append the corrector as a source on the identity row. Dedup by user_id_hash.
 * If user is a new contributor, increment distinct_user_count.
 * If the identity row has no slug yet, set it to the user's proposed slug.
 *
 * Race tolerance: read-modify-write with concurrent-writer-tolerated semantics
 * (sources array merge is set-union; counter increment is monotonic). At small
 * scale (S74.5 cold-start) collisions are rare; an advisory-lock RPC can be
 * added if telemetry surfaces issues.
 */
async function upsertCorrectorOnIdentity(opts: {
  identityId: string;
  userId: string;
  rawDescription: string;
  lineItemId: string;
  proposedSlug: string;
}): Promise<UpsertCorrectorResult | null> {
  const supabase = createServerClient();
  const { data: row, error: readErr } = await supabase
    .from("billing_code_identity")
    .select("id, service_slug, corroborator_sources, distinct_user_count, promotion_state, description_examples")
    .eq("id", opts.identityId)
    .maybeSingle();

  if (readErr || !row) return null;

  const userHash = hashUserForIdentity(opts.userId, opts.identityId);
  const existingSources = (row.corroborator_sources as SourceEntry[]) ?? [];
  const isNewContributor = !existingSources.some((s) => s.user_id_hash === userHash);

  const newEntry: SourceEntry = {
    user_id_hash: userHash,
    raw_description: opts.rawDescription,
    claim_line_item_id: opts.lineItemId,
    recorded_at: new Date().toISOString(),
  };

  // Merge: replace this user's entry (if any) with the new one; keep others.
  const merged: SourceEntry[] = [
    ...existingSources.filter((s) => s.user_id_hash !== userHash),
    newEntry,
  ].slice(0, DEFAULT_MAX_SOURCES);

  const existingExamples = (row.description_examples as string[]) ?? [];
  const updatedExamples = existingExamples.includes(opts.rawDescription)
    ? existingExamples
    : [opts.rawDescription, ...existingExamples].slice(0, 5);

  // If row has no slug yet, take the user's proposed slug. If row already has a
  // slug (from earlier corrections or auto-mapping), DON'T overwrite — the
  // promotion evaluator decides who wins via Pattern 1 #3 vote on this user's
  // contribution counting toward the existing slug's tally.
  const updates: Record<string, unknown> = {
    corroborator_sources: merged,
    description_examples: updatedExamples,
    last_corroborated_at: new Date().toISOString(),
  };

  if (isNewContributor) {
    updates.distinct_user_count = (row.distinct_user_count as number) + 1;
  }
  if (!row.service_slug) {
    updates.service_slug = opts.proposedSlug;
  }

  const { data: updated, error: writeErr } = await supabase
    .from("billing_code_identity")
    .update(updates)
    .eq("id", opts.identityId)
    .select("service_slug, distinct_user_count, promotion_state")
    .maybeSingle();

  if (writeErr || !updated) return null;

  return {
    identityId: opts.identityId,
    isNewContributor,
    distinctUserCount: updated.distinct_user_count as number,
    servedSlug: updated.service_slug as string | null,
    currentPromotionState: updated.promotion_state as UpsertCorrectorResult["currentPromotionState"],
  };
}

// ============================================================================
// Pattern 1 #3 promotion evaluator
// ============================================================================

export interface PromotionEvaluation {
  identityId: string;
  promoted: boolean;
  newPromotionState: "proposed" | "corroborated" | "admin_verified";
  promotedSlug: string | null;
  distinctUserCount: number;
  threshold: number;
  reason: string;
  backfillResult?: BackfillResult;
}

async function getPromotionThreshold(): Promise<number> {
  const supabase = createServerClient();
  const { data } = await supabase
    .from("feature_flag_rules")
    .select("config")
    .eq("flag_key", "s74_5_categorization_flywheel_v1")
    .maybeSingle();
  const cfg = data?.config as { promotion_threshold?: number } | null;
  return cfg?.promotion_threshold ?? DEFAULT_PROMOTION_THRESHOLD;
}

/**
 * Check if (code, codeType, sig) has crossed the Pattern 1 #3 threshold and
 * promote via the apply_mapping_promotion RPC if so. Idempotent: re-running
 * after promotion advances the event_type to "corroboration_added".
 */
export async function evaluateMappingPromotion(
  identityId: string,
  actorUserId: string | null = null,
  fireSource: string = "user-correction",
): Promise<PromotionEvaluation> {
  const supabase = createServerClient();
  const threshold = await getPromotionThreshold();

  const { data: row, error } = await supabase
    .from("billing_code_identity")
    .select("id, service_slug, promotion_state, distinct_user_count")
    .eq("id", identityId)
    .maybeSingle();

  if (error || !row) {
    return {
      identityId,
      promoted: false,
      newPromotionState: "proposed",
      promotedSlug: null,
      distinctUserCount: 0,
      threshold,
      reason: "identity_row_not_found",
    };
  }

  const distinctUserCount = row.distinct_user_count as number;
  const currentState = row.promotion_state as PromotionEvaluation["newPromotionState"];
  const slug = row.service_slug as string | null;

  if (!slug) {
    return {
      identityId,
      promoted: false,
      newPromotionState: currentState,
      promotedSlug: null,
      distinctUserCount,
      threshold,
      reason: "no_slug_proposed",
    };
  }

  if (currentState === "admin_verified") {
    return {
      identityId,
      promoted: false,
      newPromotionState: currentState,
      promotedSlug: slug,
      distinctUserCount,
      threshold,
      reason: "already_admin_verified",
    };
  }

  if (distinctUserCount < threshold) {
    return {
      identityId,
      promoted: false,
      newPromotionState: currentState,
      promotedSlug: slug,
      distinctUserCount,
      threshold,
      reason: `below_threshold (${distinctUserCount}/${threshold})`,
    };
  }

  // Threshold met — call RPC to atomically advance state + log event
  const { error: rpcErr } = await supabase.rpc("apply_mapping_promotion", {
    p_identity_id: identityId,
    p_new_state: "corroborated",
    p_fire_source: fireSource,
    p_actor_user_id: actorUserId,
  });

  if (rpcErr) {
    console.warn("[code-identity-promotion] apply_mapping_promotion RPC failed", rpcErr);
    return {
      identityId,
      promoted: false,
      newPromotionState: currentState,
      promotedSlug: slug,
      distinctUserCount,
      threshold,
      reason: `rpc_error: ${rpcErr.message}`,
    };
  }

  // Backfill peer rows
  const backfillResult = await backfillCorroboratedMapping(identityId, slug);

  return {
    identityId,
    promoted: true,
    newPromotionState: "corroborated",
    promotedSlug: slug,
    distinctUserCount,
    threshold,
    reason: "promoted",
    backfillResult,
  };
}

// ============================================================================
// Backfill (respects user_correction_locked_at per G4 LOCK)
// ============================================================================

export interface BackfillResult {
  updatedRowCount: number;
  conflictingUserIds: string[];
}

/**
 * Propagate the promoted slug across all peer claim_line_items rows sharing
 * this identity, except those locked by user revert decisions (G4 LOCK).
 *
 * Identifies conflicting users (those whose existing service_slug differs
 * from the newly-promoted slug AND not locked) so D6 conflict modal can fire
 * on their next /claim view.
 */
export async function backfillCorroboratedMapping(
  identityId: string,
  newSlug: string,
): Promise<BackfillResult> {
  const supabase = createServerClient();

  // 1. Identify rows that need updating (existing slug differs + not locked)
  const { data: conflictRows } = await supabase
    .from("claim_line_items")
    .select("id, claim_id, service_slug, claims(user_id)")
    .eq("billing_code_identity_id", identityId)
    .is("user_correction_locked_at", null)
    .neq("service_slug", newSlug);

  const conflictingUserIds = Array.from(
    new Set(
      (conflictRows ?? [])
        .map((r) => {
          const claims = r.claims as { user_id?: string } | { user_id?: string }[] | null;
          if (!claims) return null;
          if (Array.isArray(claims)) return claims[0]?.user_id ?? null;
          return claims.user_id ?? null;
        })
        .filter((v): v is string => Boolean(v)),
    ),
  );

  // 2. Update all unlocked rows with stale slug
  const { data: updated, error: updateErr } = await supabase
    .from("claim_line_items")
    .update({ service_slug: newSlug })
    .eq("billing_code_identity_id", identityId)
    .is("user_correction_locked_at", null)
    .neq("service_slug", newSlug)
    .select("id");

  if (updateErr) {
    console.warn("[code-identity-promotion] backfill update failed", updateErr);
    return { updatedRowCount: 0, conflictingUserIds: [] };
  }

  return {
    updatedRowCount: updated?.length ?? 0,
    conflictingUserIds,
  };
}

// ============================================================================
// Conflict-user lookup for D6 modal queueing
// ============================================================================

export interface ConflictedRow {
  userId: string;
  lineItemId: string;
  previousSlug: string | null;
  promotedSlug: string;
}

/**
 * After a promotion lands and backfill runs, return the set of rows that
 * the conflict modal should surface for. Called by D6 on /claim view fetch.
 */
export async function getConflictedRowsForIdentity(
  identityId: string,
  newSlug: string,
): Promise<ConflictedRow[]> {
  const supabase = createServerClient();
  const { data } = await supabase
    .from("claim_line_items")
    .select("id, service_slug, claims(user_id), user_corrected_at, user_correction_locked_at")
    .eq("billing_code_identity_id", identityId)
    .not("user_corrected_at", "is", null)
    .is("user_correction_locked_at", null);

  if (!data) return [];

  const rows: ConflictedRow[] = [];
  for (const r of data) {
    const claims = r.claims as { user_id?: string } | { user_id?: string }[] | null;
    const userId = Array.isArray(claims) ? claims[0]?.user_id : claims?.user_id;
    const prevSlug = r.service_slug as string | null;
    if (userId && prevSlug !== newSlug) {
      rows.push({
        userId,
        lineItemId: r.id as string,
        previousSlug: prevSlug,
        promotedSlug: newSlug,
      });
    }
  }
  return rows;
}

// ============================================================================
// recordUserCorrection — full flow called by D5 API endpoint
// ============================================================================

export interface RecordCorrectionResult {
  ok: boolean;
  contributedToFlywheel: boolean;
  reason?: string;
  identityId?: string;
  promotion?: PromotionEvaluation;
}

export async function recordUserCorrection(opts: {
  lineItemId: string;
  userId: string;
  newSlug: string;
  billingCode: string;
  billingCodeType: ProcedureCodeType | undefined;
  description: string;
}): Promise<RecordCorrectionResult> {
  const supabase = createServerClient();
  const codeType = opts.billingCodeType ?? inferProcedureCodeType(opts.billingCode);
  if (!codeType) {
    return { ok: false, contributedToFlywheel: false, reason: "unknown_code_type" };
  }

  // Always update the user's own claim_line_items row immediately, regardless
  // of Pattern 1 #15 verification — they own their data per Pattern 1 #14.
  const { error: userRowErr } = await supabase
    .from("claim_line_items")
    .update({
      service_slug: opts.newSlug,
      user_corrected_at: new Date().toISOString(),
    })
    .eq("id", opts.lineItemId);

  if (userRowErr) {
    console.warn("[code-identity-promotion] user row update failed", userRowErr);
    return { ok: false, contributedToFlywheel: false, reason: "user_row_update_failed" };
  }

  // Flywheel contribution gated on Pattern 1 #15 (EMAIL + PHONE verified)
  const isVerified = await isUserFullyVerified(opts.userId);
  if (!isVerified) {
    return {
      ok: true,
      contributedToFlywheel: false,
      reason: "user_not_email_phone_verified",
    };
  }

  // Find or create the signature row
  const signature = normalizeDescriptionSignature(opts.description, opts.billingCode);
  if (!signature) {
    return { ok: true, contributedToFlywheel: false, reason: "empty_signature" };
  }

  let identity = await lookupExactSignature(opts.billingCode, codeType, signature);
  if (!identity) {
    identity = await proposeNewSignature({
      code: opts.billingCode,
      codeType,
      signature,
      rawDescription: opts.description,
      proposedSlug: opts.newSlug,
      proposedByUserId: opts.userId,
    });
  }
  if (!identity) {
    return { ok: true, contributedToFlywheel: false, reason: "identity_create_failed" };
  }

  // Link the user's claim_line_item to the identity row (for backfill targeting)
  await supabase
    .from("claim_line_items")
    .update({ billing_code_identity_id: identity.identityId })
    .eq("id", opts.lineItemId);

  // Add corrector source + maybe increment distinct_user_count
  await upsertCorrectorOnIdentity({
    identityId: identity.identityId,
    userId: opts.userId,
    rawDescription: opts.description,
    lineItemId: opts.lineItemId,
    proposedSlug: opts.newSlug,
  });

  // Fire Pattern 1 #3 evaluator
  const promotion = await evaluateMappingPromotion(identity.identityId, opts.userId);

  return {
    ok: true,
    contributedToFlywheel: true,
    identityId: identity.identityId,
    promotion,
  };
}
