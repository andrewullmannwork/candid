// S74.5 D3 — Pattern 1 #3 promotion evaluator for billing-code mappings.
//
// Per plans/s74.5_categorization_flywheel.md v2 §6 + Q2 LOCK (fixed threshold 3) +
// Q4 LOCK (event log mirrors canonical_promotion_events) + G4 LOCK (sticky
// per-account user_correction_locked_at).
//
// Session 84 (S74.5c) refactor per plans/findings/s74.5_skeptical_review.md:
//   §1.1 — per-slug vote tracking: SourceEntry carries `proposed_slug` + `source`;
//          evaluateMappingPromotion tallies votes per slug and promotes only when
//          a single slug has >= threshold votes. service_slug stays NULL on the
//          identity row until promotion fires.
//   §1.5 — parser-path observation: recordParserObservation appends a
//          bill_observed SourceEntry (proposed_slug=null) so parser-path
//          ingestion counts toward distinct_user_count without casting a vote.
//   §3.5 — advisory lock: both write paths (user_correction + bill_observed)
//          go through apply_corrector_upsert RPC which holds pg_advisory_xact_lock
//          for the composite key — eliminates the read-modify-write race.
//   §3.6 — D5 captures optional `reason` + `note` on user correction; passed
//          through to flywheel telemetry log.
//
// Exports:
//   - recordUserCorrection()   — D5 endpoint flow
//   - recordParserObservation() — D4 parser flow (§1.5)
//   - evaluateMappingPromotion() — Pattern 1 #3 vote-tally evaluator (§1.1)
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
// SourceEntry shape (§1.1 + §1.5 extended)
// ============================================================================

export type CorroboratorSource = "user_correction" | "bill_observed";

export interface SourceEntry {
  user_id_hash: string;
  source: CorroboratorSource;
  proposed_slug: string | null;
  raw_description: string;
  claim_line_item_id: string | null;
  recorded_at: string;
}

function hashUserForIdentity(userId: string, identityId: string): string {
  // Stable per (user, identity) — same user re-recording on the same identity
  // collapses to one source entry. Cross-identity reuse re-hashes.
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
  skippedReason?: string;
}

interface UpsertRpcResponse {
  is_new_contributor?: boolean;
  distinct_user_count?: number;
  service_slug?: string | null;
  promotion_state?: "proposed" | "corroborated" | "admin_verified";
  skipped_reason?: string;
}

async function applyCorrectorUpsert(opts: {
  identityId: string;
  userId: string;
  proposedSlug: string | null;
  source: CorroboratorSource;
  rawDescription: string;
  lineItemId: string | null;
}): Promise<UpsertCorrectorResult | null> {
  const supabase = createServerClient();
  const userHash = hashUserForIdentity(opts.userId, opts.identityId);

  const { data, error } = await supabase.rpc("apply_corrector_upsert", {
    p_identity_id: opts.identityId,
    p_user_id_hash: userHash,
    p_proposed_slug: opts.proposedSlug,
    p_source: opts.source,
    p_raw_description: opts.rawDescription,
    p_claim_line_item_id: opts.lineItemId,
  });

  if (error || !data) {
    console.warn("[code-identity-promotion] apply_corrector_upsert RPC failed", error);
    return null;
  }

  const r = data as UpsertRpcResponse;
  return {
    identityId: opts.identityId,
    isNewContributor: Boolean(r.is_new_contributor),
    distinctUserCount: Number(r.distinct_user_count ?? 0),
    servedSlug: (r.service_slug as string | null) ?? null,
    currentPromotionState:
      (r.promotion_state as UpsertCorrectorResult["currentPromotionState"]) ??
      "proposed",
    skippedReason: r.skipped_reason,
  };
}

// ============================================================================
// Pattern 1 #3 promotion evaluator (§1.1 vote-tally)
// ============================================================================

export interface PromotionEvaluation {
  identityId: string;
  promoted: boolean;
  newPromotionState: "proposed" | "corroborated" | "admin_verified";
  promotedSlug: string | null;
  distinctUserCount: number;
  winningVoteCount: number;
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

interface TallyResult {
  winningSlug: string | null;
  winningCount: number;
  totalVotes: number;
  distinctSlugs: number;
}

function tallySlugVotes(sources: SourceEntry[]): TallyResult {
  const tally = new Map<string, number>();
  for (const s of sources) {
    if (s.source !== "user_correction") continue;
    if (!s.proposed_slug) continue;
    tally.set(s.proposed_slug, (tally.get(s.proposed_slug) ?? 0) + 1);
  }
  // S74.5c C-2 — deterministic tie-breaking. When two or more slugs reach
  // the same vote count, sort by slug name ascending so the choice is
  // reproducible (replaying the same source set always produces the same
  // winner). Without this, Map iteration order would silently make
  // "first-to-reach-threshold" the winner, which is correct semantically
  // but undocumented and dependent on insertion order. Alphabetical fallback
  // is arbitrary but stable + observable in test fixtures.
  const tallyEntries = Array.from(tally.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1]; // desc by count
    return a[0].localeCompare(b[0]); // asc by slug name as tiebreaker
  });
  let totalVotes = 0;
  for (const [, n] of tallyEntries) totalVotes += n;
  const top = tallyEntries[0] ?? null;
  return {
    winningSlug: top ? top[0] : null,
    winningCount: top ? top[1] : 0,
    totalVotes,
    distinctSlugs: tally.size,
  };
}

/**
 * §1.1 vote-tally promotion. Reads corroborator_sources, tallies user_correction
 * votes per slug, and promotes when one slug reaches the threshold. service_slug
 * is set ONLY at promotion time (by apply_mapping_promotion below — we set it
 * via a separate UPDATE before the RPC fires so the RPC's event log records the
 * winning slug correctly).
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
    .select("id, service_slug, promotion_state, distinct_user_count, corroborator_sources")
    .eq("id", identityId)
    .maybeSingle();

  if (error || !row) {
    return {
      identityId,
      promoted: false,
      newPromotionState: "proposed",
      promotedSlug: null,
      distinctUserCount: 0,
      winningVoteCount: 0,
      threshold,
      reason: "identity_row_not_found",
    };
  }

  const distinctUserCount = Number(row.distinct_user_count ?? 0);
  const currentState = row.promotion_state as PromotionEvaluation["newPromotionState"];
  const currentSlug = row.service_slug as string | null;
  const sources = (row.corroborator_sources as SourceEntry[] | null) ?? [];

  if (currentState === "admin_verified") {
    return {
      identityId,
      promoted: false,
      newPromotionState: currentState,
      promotedSlug: currentSlug,
      distinctUserCount,
      winningVoteCount: 0,
      threshold,
      reason: "already_admin_verified",
    };
  }

  const tally = tallySlugVotes(sources);
  if (!tally.winningSlug || tally.winningCount < threshold) {
    // No slug has reached the threshold yet. If multiple distinct slugs have
    // votes but none won, signal disagreement (admin can disambiguate).
    const reason =
      tally.totalVotes === 0
        ? "no_slug_votes"
        : tally.distinctSlugs > 1
          ? `slug_disagreement (top=${tally.winningCount}/${threshold}, ${tally.distinctSlugs} distinct slugs)`
          : `below_threshold (${tally.winningCount}/${threshold})`;
    return {
      identityId,
      promoted: false,
      newPromotionState: currentState,
      promotedSlug: currentSlug,
      distinctUserCount,
      winningVoteCount: tally.winningCount,
      threshold,
      reason,
    };
  }

  // Threshold met for tally.winningSlug. Two cases:
  //  (a) currentState === 'corroborated' and slug matches — emit event log
  //      ("corroboration_added") but no state advance.
  //  (b) currentState === 'proposed' — set service_slug to winning slug
  //      AND advance state in a SINGLE atomic RPC (promote_with_slug)
  //      so the slug-write + state advance + event log all happen under
  //      one advisory lock. Per S74.5c C-3 — eliminates the race window
  //      between a separate UPDATE and apply_mapping_promotion call.
  const slugToWrite = currentSlug !== tally.winningSlug ? tally.winningSlug : null;
  const { error: rpcErr } = await supabase.rpc("promote_with_slug", {
    p_identity_id: identityId,
    p_new_state: "corroborated",
    p_set_slug: slugToWrite,
    p_fire_source: fireSource,
    p_actor_user_id: actorUserId,
  });

  if (rpcErr) {
    console.warn("[code-identity-promotion] apply_mapping_promotion RPC failed", rpcErr);
    return {
      identityId,
      promoted: false,
      newPromotionState: currentState,
      promotedSlug: tally.winningSlug,
      distinctUserCount,
      winningVoteCount: tally.winningCount,
      threshold,
      reason: `rpc_error: ${rpcErr.message}`,
    };
  }

  const backfillResult = await backfillCorroboratedMapping(
    identityId,
    tally.winningSlug,
  );

  return {
    identityId,
    promoted: true,
    newPromotionState: "corroborated",
    promotedSlug: tally.winningSlug,
    distinctUserCount,
    winningVoteCount: tally.winningCount,
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
 *
 * G4 LOCK preservation: for any row with a prior user_corrected_at, we
 * snapshot the user's slug into metadata.user_correction_pre_backfill_slug
 * BEFORE overwriting service_slug. The D6 CommunityConflictModal reads this
 * snapshot to render "you previously set it to X" copy; the
 * resolve-conflict endpoint restores it on Revert.
 */
export async function backfillCorroboratedMapping(
  identityId: string,
  newSlug: string,
): Promise<BackfillResult> {
  const supabase = createServerClient();

  // 1. Identify rows that need updating (existing slug differs + not locked)
  const { data: conflictRows } = await supabase
    .from("claim_line_items")
    .select(
      "id, claim_id, service_slug, user_corrected_at, metadata, claims(user_id)",
    )
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

  // 2. For rows with user_corrected_at, snapshot prior slug into metadata
  // BEFORE the slug overwrite below. Allows G4 Revert action to restore.
  const userCorrectedRows = (conflictRows ?? []).filter(
    (r) => r.user_corrected_at != null,
  );
  for (const row of userCorrectedRows) {
    const meta = (row.metadata as Record<string, unknown> | null) ?? {};
    // Don't clobber an existing snapshot — if user already saw + dismissed a
    // prior conflict on this same row, the original-original slug is what
    // matters; this iteration's snapshot is a duplicate.
    if (meta.user_correction_pre_backfill_slug != null) continue;
    await supabase
      .from("claim_line_items")
      .update({
        metadata: {
          ...meta,
          user_correction_pre_backfill_slug: row.service_slug,
          user_correction_pre_backfill_at: new Date().toISOString(),
        },
      })
      .eq("id", row.id);
  }

  // 3. Update all unlocked rows with stale slug
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
// §1.5 — Parser-path observation (bill_observed; no slug vote)
// ============================================================================

/**
 * Append a bill_observed source entry on an identity row that the parser just
 * categorized for this user's bill. Counts toward distinct_user_count but
 * NOT toward any slug's vote tally (§1.1 separation).
 *
 * Pattern 1 #15 gated: skipped silently for users without verified email+phone
 * (the audit pipeline keeps running; the flywheel just doesn't accumulate
 * their observations).
 *
 * Idempotent — re-running for the same (user, identity) is a no-op via the
 * RPC's source-priority rule. If the user has an existing user_correction
 * entry for this identity, the parser observation is dropped (user_correction
 * takes precedence; passive observation cannot displace explicit correction).
 */
export async function recordParserObservation(opts: {
  identityId: string;
  userId: string;
  rawDescription: string;
  lineItemId?: string | null;
}): Promise<UpsertCorrectorResult | null> {
  if (!opts.userId) return null;
  const verified = await isUserFullyVerified(opts.userId);
  if (!verified) return null;

  return applyCorrectorUpsert({
    identityId: opts.identityId,
    userId: opts.userId,
    proposedSlug: null,
    source: "bill_observed",
    rawDescription: opts.rawDescription,
    lineItemId: opts.lineItemId ?? null,
  });
}

// ============================================================================
// recordUserCorrection — full flow called by D5 API endpoint
// ============================================================================

export type CorrectionReason =
  | "wrong_service"
  | "wrong_code_type"
  | "missing_modifier"
  | "ambiguous_description"
  | "other";

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
  correctionReason?: CorrectionReason;
  correctionNote?: string;
}): Promise<RecordCorrectionResult> {
  const supabase = createServerClient();
  const codeType = opts.billingCodeType ?? inferProcedureCodeType(opts.billingCode);
  if (!codeType) {
    return { ok: false, contributedToFlywheel: false, reason: "unknown_code_type" };
  }

  // Always update the user's own claim_line_items row immediately, regardless
  // of Pattern 1 #15 verification — they own their data per Pattern 1 #14.
  // §3.6 — capture correction reason + note on the row so D5 telemetry can mine.
  const liMetaUpdate: Record<string, unknown> = {};
  if (opts.correctionReason) {
    liMetaUpdate.last_correction_reason = opts.correctionReason;
  }
  if (opts.correctionNote) {
    liMetaUpdate.last_correction_note = opts.correctionNote;
  }

  // Read existing metadata so we don't blow away other keys (auditFindings, etc.)
  const { data: existingLi } = await supabase
    .from("claim_line_items")
    .select("metadata")
    .eq("id", opts.lineItemId)
    .maybeSingle();
  const mergedMeta = {
    ...((existingLi?.metadata as Record<string, unknown> | null) ?? {}),
    ...liMetaUpdate,
    last_correction_at: new Date().toISOString(),
  };

  const { error: userRowErr } = await supabase
    .from("claim_line_items")
    .update({
      service_slug: opts.newSlug,
      user_corrected_at: new Date().toISOString(),
      metadata: mergedMeta,
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
    // §1.1 — newly proposed rows ALWAYS start with service_slug=null. The
    // user's chosen slug becomes their vote in the SourceEntry below; the
    // row's slug is set only when promotion fires.
    identity = await proposeNewSignature({
      code: opts.billingCode,
      codeType,
      signature,
      rawDescription: opts.description,
      proposedSlug: null,
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

  // §3.5 — advisory-locked atomic source upsert
  await applyCorrectorUpsert({
    identityId: identity.identityId,
    userId: opts.userId,
    proposedSlug: opts.newSlug,
    source: "user_correction",
    rawDescription: opts.description,
    lineItemId: opts.lineItemId,
  });

  // §3.6 — telemetry log on the correction (structured; downstream Pattern P-9 candidate)
  if (opts.correctionReason) {
    console.log("[code-identity-promotion] user_correction_with_reason", {
      identityId: identity.identityId,
      userId: opts.userId,
      lineItemId: opts.lineItemId,
      reason: opts.correctionReason,
      hasNote: Boolean(opts.correctionNote),
      proposedSlug: opts.newSlug,
    });
  }

  // §1.1 — Pattern 1 #3 vote-tally evaluator
  const promotion = await evaluateMappingPromotion(identity.identityId, opts.userId);

  return {
    ok: true,
    contributedToFlywheel: true,
    identityId: identity.identityId,
    promotion,
  };
}
