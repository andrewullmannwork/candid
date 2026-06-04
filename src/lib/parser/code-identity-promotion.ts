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
import { isPiiRedactionEnabled, redactExcerpt } from "./pii-redaction-gate";
import {
  lookupExactSignature,
  proposeNewSignature,
  normalizeDescriptionSignature,
} from "./code-identity";
import { inferProcedureCodeType } from "../billing/code-type-inference";
import type { ProcedureCodeType } from "../billing/types";
import * as crypto from "crypto";

// S74.6 D4 — raised from 3 to 5 specifically for billing_code_identity.
// Haiku description-match votes (D4) will dominate the corpus and Haiku-only
// convergence at 3 is too easy to be wrong; 5 distinct verified users gives
// the right Haiku-heavy compensation per Subplan §1 lock.
// Threshold remains runtime-tunable via feature_flag_rules.config.promotion_threshold.
const DEFAULT_PROMOTION_THRESHOLD = 5;

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

export type CorroboratorSource =
  | "user_correction"
  | "bill_observed"
  // S74.6 D4 — Haiku description-match vote (score ≥0.85); casts vote toward
  // the matched slug. NOT user-correction (passive Haiku inference).
  | "bill_observed_description_match"
  // S74.6 D4 — ambiguous (2+ candidates within 0.05 score). Written on BOTH
  // candidate identity rows. Counts toward distinct_user_count but does NOT
  // vote for any slug. Admin disambiguates via queue.
  | "bill_observed_description_match_candidate"
  // S74.6 D4 — admin pre-seed from public sources (CMS / CDC / USPSTF).
  // Counts as 1 vote toward the 5-vote threshold, NOT auto-authority.
  | "admin_seed"
  // S74.6 D5 — captured from dispute-outcome `recodedAs`. The insurer paid
  // on the alternative code; that's a strong real-world signal for the
  // (alternative_code → slug) binding.
  | "dispute_won_recoding";

export interface SourceEntry {
  user_id_hash: string;
  source: CorroboratorSource;
  proposed_slug: string | null;
  raw_description: string;
  claim_line_item_id: string | null;
  recorded_at: string;
  // S74.6 D4 — Haiku similarity score persisted for telemetry + admin
  // disambiguation view. Populated only on `bill_observed_description_match`
  // and `bill_observed_description_match_candidate` source entries.
  haiku_score?: number | null;
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
  // S74.6 D4 §D.3 — Haiku similarity 0..1 for description-match sources.
  // null/undefined for non-Haiku sources (user_correction, bill_observed,
  // admin_seed, dispute_won_recoding).
  haikuScore?: number | null;
}): Promise<UpsertCorrectorResult | null> {
  const supabase = createServerClient();
  const userHash = hashUserForIdentity(opts.userId, opts.identityId);

  // Ing-E: redact PII from the bill line-item description before it's stored in
  // billing_code_identity.corroborator_sources[].raw_description (cross-user).
  // Flag OFF (default) → unchanged → byte-identical. (description_signature, a
  // matching key, is intentionally NOT redacted here — audit shows 0 PII there.)
  const piiOn = await isPiiRedactionEnabled(supabase);

  const { data, error } = await supabase.rpc("apply_corrector_upsert", {
    p_identity_id: opts.identityId,
    p_user_id_hash: userHash,
    p_proposed_slug: opts.proposedSlug,
    p_source: opts.source,
    p_raw_description: redactExcerpt(opts.rawDescription, piiOn, "billing_code_identity.corroborator_sources.raw_description"),
    p_claim_line_item_id: opts.lineItemId,
    p_haiku_score: opts.haikuScore ?? null,
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
  // S74.6 D4 — vote-casting source types (slug-affirming):
  //   user_correction                  — explicit user choice
  //   bill_observed_description_match  — Haiku similarity ≥0.85
  //   admin_seed                       — admin pre-seed (1 vote, NOT authority)
  //   dispute_won_recoding             — insurer paid on alternative code (D5 capture)
  // Non-voting (counts toward distinct_user_count but no slug vote):
  //   bill_observed                              — passive parser observation
  //   bill_observed_description_match_candidate  — ambiguous (2+ within 0.05)
  const VOTING_SOURCES = new Set([
    "user_correction",
    "bill_observed_description_match",
    "admin_seed",
    "dispute_won_recoding",
  ]);
  for (const s of sources) {
    if (!VOTING_SOURCES.has(s.source)) continue;
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
// S74.6 D4 §D.1 + §D.2 — Description-match vote-recording + ambiguous-candidate
// writes. The D4 audit rule emits findings with provisional slug + haiku score
// in metadata; persist.ts reads that metadata after line-item insert and routes
// to one of these helpers (confident → vote; ambiguous → 2-row + admin queue).
// ============================================================================

export interface RecordDescriptionMatchVoteResult {
  ok: boolean;
  contributedToFlywheel: boolean;
  reason?: string;
  identityId?: string;
  promotion?: PromotionEvaluation;
}

/**
 * §D.1 — Cast a Haiku-confident description-match vote on the
 * billing_code_identity row for (billingCode, billingCodeType, signature).
 * Finds or creates the row (mirrors recordUserCorrection's lookup-or-propose
 * pattern), writes a `bill_observed_description_match` SourceEntry with the
 * Haiku score, then runs the vote-tally promotion evaluator.
 *
 * Pattern 1 #15 gated: skipped silently for non-verified users. The audit
 * pipeline still emits the finding; only the flywheel write is skipped.
 */
export async function recordDescriptionMatchVote(opts: {
  userId: string;
  billingCode: string;
  billingCodeType: ProcedureCodeType | undefined;
  rawDescription: string;
  proposedSlug: string;
  haikuScore: number;
  lineItemId: string | null;
}): Promise<RecordDescriptionMatchVoteResult> {
  if (!opts.userId) return { ok: false, contributedToFlywheel: false, reason: "no_user_id" };
  const verified = await isUserFullyVerified(opts.userId);
  if (!verified) {
    return { ok: true, contributedToFlywheel: false, reason: "user_not_email_phone_verified" };
  }

  const codeType = opts.billingCodeType ?? inferProcedureCodeType(opts.billingCode);
  if (!codeType) {
    return { ok: false, contributedToFlywheel: false, reason: "unknown_code_type" };
  }

  const signature = normalizeDescriptionSignature(opts.rawDescription, opts.billingCode);
  if (!signature) {
    return { ok: true, contributedToFlywheel: false, reason: "empty_signature" };
  }

  let identity = await lookupExactSignature(opts.billingCode, codeType, signature);
  if (!identity) {
    identity = await proposeNewSignature({
      code: opts.billingCode,
      codeType,
      signature,
      rawDescription: opts.rawDescription,
      proposedSlug: null, // slug set only on promotion
      proposedByUserId: opts.userId,
    });
  }
  if (!identity) {
    return { ok: true, contributedToFlywheel: false, reason: "identity_create_failed" };
  }

  await applyCorrectorUpsert({
    identityId: identity.identityId,
    userId: opts.userId,
    proposedSlug: opts.proposedSlug,
    source: "bill_observed_description_match",
    rawDescription: opts.rawDescription,
    lineItemId: opts.lineItemId,
    haikuScore: opts.haikuScore,
  });

  const promotion = await evaluateMappingPromotion(
    identity.identityId,
    opts.userId,
    "description-match-vote",
  );

  return {
    ok: true,
    contributedToFlywheel: true,
    identityId: identity.identityId,
    promotion,
  };
}

export interface RecordAmbiguousCandidateResult {
  ok: boolean;
  contributedToFlywheel: boolean;
  reason?: string;
  /** Both identity rows that received the candidate source entries. */
  identityIds?: string[];
  /** True when an admin-queue row was inserted for this ambiguity. */
  adminQueueEnqueued?: boolean;
}

/**
 * §D.2 — Write TWO `billing_code_identity` rows (one per ambiguous candidate
 * slug), both carrying a `bill_observed_description_match_candidate` source
 * entry (non-voting per the CorroboratorSource vote-rules), and enqueue an
 * admin review row for human disambiguation.
 *
 * Both rows share the same `(billingCode, billingCodeType, description_signature)`
 * tuple — proposeNewSignature handles the find-or-create. The DIFFERENT slugs
 * are encoded only in the SourceEntry's `proposed_slug` field (non-voting), not
 * on the identity row's `service_slug` (which stays null until promotion).
 *
 * Edge case: when both candidates resolve to the SAME identity row (same code +
 * signature; only difference is the slug guess), we write one row with two
 * candidate sources from the same user. That's correct — the admin queue row
 * still captures the disambiguation need.
 *
 * Pattern 1 #15 gated.
 */
export async function recordAmbiguousCandidate(opts: {
  userId: string;
  billingCode: string;
  billingCodeType: ProcedureCodeType | undefined;
  rawDescription: string;
  topMatch: { slug: string; score: number };
  secondMatch: { slug: string; score: number };
  lineItemId: string | null;
}): Promise<RecordAmbiguousCandidateResult> {
  if (!opts.userId) return { ok: false, contributedToFlywheel: false, reason: "no_user_id" };
  const verified = await isUserFullyVerified(opts.userId);
  if (!verified) {
    return { ok: true, contributedToFlywheel: false, reason: "user_not_email_phone_verified" };
  }

  const codeType = opts.billingCodeType ?? inferProcedureCodeType(opts.billingCode);
  if (!codeType) {
    return { ok: false, contributedToFlywheel: false, reason: "unknown_code_type" };
  }

  const signature = normalizeDescriptionSignature(opts.rawDescription, opts.billingCode);
  if (!signature) {
    return { ok: true, contributedToFlywheel: false, reason: "empty_signature" };
  }

  // Both candidates share the same identity row (same code + signature).
  let identity = await lookupExactSignature(opts.billingCode, codeType, signature);
  if (!identity) {
    identity = await proposeNewSignature({
      code: opts.billingCode,
      codeType,
      signature,
      rawDescription: opts.rawDescription,
      proposedSlug: null,
      proposedByUserId: opts.userId,
    });
  }
  if (!identity) {
    return { ok: true, contributedToFlywheel: false, reason: "identity_create_failed" };
  }

  // Write the top-1 candidate as the active SourceEntry (one user can only
  // have ONE entry per identity per RPC contract; the admin queue row carries
  // BOTH candidate slugs so the admin can pick the correct one).
  await applyCorrectorUpsert({
    identityId: identity.identityId,
    userId: opts.userId,
    proposedSlug: opts.topMatch.slug, // non-voting (source type filtered out by tally)
    source: "bill_observed_description_match_candidate",
    rawDescription: opts.rawDescription,
    lineItemId: opts.lineItemId,
    haikuScore: opts.topMatch.score,
  });

  // Flip the identity's promotion_state to 'ambiguous_candidate' so the admin
  // UI can filter for these. Mig 094 widened the CHECK to admit this value.
  // Existing state semantics preserved: any later user_correction promotes the
  // row OUT of ambiguous_candidate state via promote_with_slug.
  const supabase = createServerClient();
  await supabase
    .from("billing_code_identity")
    .update({ promotion_state: "ambiguous_candidate" })
    .eq("id", identity.identityId)
    .eq("promotion_state", "proposed"); // never overwrite corroborated / admin_verified

  // Enqueue an admin review row carrying both candidate slugs. The existing
  // code_identity_admin_review_queue (mig 087) has columns: id, identity_id,
  // proposed_by_user_id, candidate_slugs JSONB, status, created_at. Inserted
  // only when a row for this (identity, user) pair doesn't already exist.
  let adminQueueEnqueued = false;
  try {
    const { data: existingQ } = await supabase
      .from("code_identity_admin_review_queue")
      .select("id")
      .eq("identity_id", identity.identityId)
      .eq("proposed_by_user_id", opts.userId)
      .maybeSingle();
    if (!existingQ) {
      const { error: queueErr } = await supabase
        .from("code_identity_admin_review_queue")
        .insert({
          identity_id: identity.identityId,
          proposed_by_user_id: opts.userId,
          candidate_slugs: [
            { slug: opts.topMatch.slug, score: opts.topMatch.score },
            { slug: opts.secondMatch.slug, score: opts.secondMatch.score },
          ],
          status: "pending",
          source_line_item_id: opts.lineItemId,
        });
      if (!queueErr) adminQueueEnqueued = true;
      else console.warn("[code-identity-promotion] admin queue insert failed", queueErr);
    } else {
      // Already queued for this user; no double-insert. Counts as enqueued
      // for caller's purposes.
      adminQueueEnqueued = true;
    }
  } catch (err) {
    console.warn("[code-identity-promotion] admin queue write threw", err);
  }

  return {
    ok: true,
    contributedToFlywheel: true,
    identityIds: [identity.identityId],
    adminQueueEnqueued,
  };
}

// ============================================================================
// S74.6 D5 §E.1 — Dispute-won recoding vote-recording.
// ============================================================================

export interface RecordDisputeWonRecodingResult {
  ok: boolean;
  contributedToFlywheel: boolean;
  reason?: string;
  identityId?: string;
  promotion?: PromotionEvaluation;
}

/**
 * §E.1 — When a dispute marked `won_on_escalation` captures `recodedAs={code,
 * codeType}`, write a `dispute_won_recoding` SourceEntry on the
 * `(recodedAsCode, recodedAsCodeType, <signature-from-original-line>)`
 * identity row. The signal: "the insurer paid on the alternative code for
 * this service description" — strong real-world evidence that the recoded
 * code maps to the same service slug the original line was bound to.
 *
 * Description signature is computed from the ORIGINAL line's description
 * paired with the RECODED code (per Q-S87-C4 Option A — trust the
 * description_signature dimension; the recoding signal says "this service
 * description maps to BOTH codes"). Original slug becomes the proposed_slug
 * vote on the new identity row.
 *
 * Pattern 1 #15 gated.
 */
export async function recordDisputeWonRecoding(opts: {
  userId: string;
  disputeId: string;
  recodedAsCode: string;
  recodedAsCodeType: ProcedureCodeType | string;
}): Promise<RecordDisputeWonRecodingResult> {
  if (!opts.userId) return { ok: false, contributedToFlywheel: false, reason: "no_user_id" };
  const verified = await isUserFullyVerified(opts.userId);
  if (!verified) {
    return { ok: true, contributedToFlywheel: false, reason: "user_not_email_phone_verified" };
  }

  const supabase = createServerClient();

  // 1. Read the dispute's primary line item — it carries the original code's
  // description + slug needed to build the new identity row.
  const { data: dispute } = await supabase
    .from("dispute_outcomes")
    .select("claim_line_item_id")
    .eq("id", opts.disputeId)
    .maybeSingle();
  const primaryLineItemId = dispute?.claim_line_item_id as string | null;
  if (!primaryLineItemId) {
    return {
      ok: true,
      contributedToFlywheel: false,
      reason: "dispute_has_no_primary_line_item",
    };
  }

  const { data: line } = await supabase
    .from("claim_line_items")
    .select("id, description, service_slug")
    .eq("id", primaryLineItemId)
    .maybeSingle();
  const originalDescription = (line?.description as string | null) ?? null;
  const originalSlug = (line?.service_slug as string | null) ?? null;
  if (!originalDescription || !originalSlug) {
    // Without a slug to vote for, we can't cast a meaningful recoding vote.
    return {
      ok: true,
      contributedToFlywheel: false,
      reason: "original_line_missing_description_or_slug",
    };
  }

  const codeType = (
    typeof opts.recodedAsCodeType === "string"
      ? inferProcedureCodeType(opts.recodedAsCode) ?? (opts.recodedAsCodeType as ProcedureCodeType)
      : opts.recodedAsCodeType
  ) as ProcedureCodeType | undefined;
  if (!codeType) {
    return { ok: false, contributedToFlywheel: false, reason: "unknown_code_type" };
  }

  // 2. Compute signature using the ORIGINAL description paired with the
  // RECODED code (per Q-S87-C4 Option A).
  const signature = normalizeDescriptionSignature(originalDescription, opts.recodedAsCode);
  if (!signature) {
    return { ok: true, contributedToFlywheel: false, reason: "empty_signature" };
  }

  // 3. Find or create the identity row for the recoded code.
  let identity = await lookupExactSignature(opts.recodedAsCode, codeType, signature);
  if (!identity) {
    identity = await proposeNewSignature({
      code: opts.recodedAsCode,
      codeType,
      signature,
      rawDescription: originalDescription,
      proposedSlug: null,
      proposedByUserId: opts.userId,
    });
  }
  if (!identity) {
    return { ok: true, contributedToFlywheel: false, reason: "identity_create_failed" };
  }

  // 4. Cast the dispute-won-recoding vote toward the ORIGINAL slug.
  await applyCorrectorUpsert({
    identityId: identity.identityId,
    userId: opts.userId,
    proposedSlug: originalSlug,
    source: "dispute_won_recoding",
    rawDescription: originalDescription,
    lineItemId: primaryLineItemId,
  });

  // 5. Evaluate promotion.
  const promotion = await evaluateMappingPromotion(
    identity.identityId,
    opts.userId,
    "dispute-won-recoding",
  );

  return {
    ok: true,
    contributedToFlywheel: true,
    identityId: identity.identityId,
    promotion,
  };
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
