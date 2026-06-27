/**
 * Active corroboration challenge state machine (Phase 4.0.6 Task 4.0.6-F).
 *
 * Implements the 3-step flow per [[Candid_Data_Principles]] §8.2:
 *   1. Sanity check — re-parse user's own document for the corrected field
 *   2. Active corroboration challenge — track corroboration vs contradiction
 *      counts as subsequent first-parses arrive
 *   3. Resolution — corroborated → standard Pattern 1 #3 promotion event;
 *      contradicted → challenge dismissed; time-decay (90 days default) →
 *      admin review queue
 *
 * Backed by canonical_correction_challenges table (mig 068; Q-P4.0.6-4 LOCK = (C)
 * NEW table — separate from benefit_corrections per CLAUDE.md Rule #1).
 *
 * Admin notification stub (`enqueueChallengeNotification`) is replaced by the
 * full Slack + email + queue + Slack-failure fallback mechanism in Task 4.0.6-K
 * per Q-P4.0.6-6 LOCK v4 tiered notification.
 *
 * Integration point: `checkAndUpdatePendingChallenges()` is called from
 * `commit-and-evaluate.ts` when a value mismatch is observed against canonical;
 * iterates pending challenges + updates corroboration/contradiction counts +
 * auto-resolves on threshold met.
 */

import type { createServerClient } from "@/lib/supabase/server";
import { applyPromotionEvent } from "./promotion-event";
import { sendChallengeNotification as sendChallengeNotificationV1 } from "@/lib/notifications/canonical-promotion-notifications";

type SupabaseClient = ReturnType<typeof createServerClient>;

export type ChallengeStatus =
  | "pending_sanity_check"
  | "pending_corroboration"
  | "pending_contradiction"
  | "corroborated"
  | "contradicted"
  | "time_decayed"
  | "admin_review_requested"
  | "admin_overridden"
  | "sanity_failed_admin_queue";

export type ChallengeNotificationEvent =
  | "submitted"
  | "sanity_passed"
  | "sanity_failed"
  | "corroboration_added"
  | "contradiction_added"
  | "resolved_corroborated"
  | "resolved_contradicted"
  | "time_decayed"
  | "admin_overridden";

export interface CorrectionChallengeRow {
  id: string;
  canonical_plan_id: string;
  service_slug: string | null;
  field_name: string;
  benefit_correction_id: string | null;
  proposed_value: unknown;
  proposed_by_user_id: string;
  sanity_check_passed: boolean | null;
  sanity_check_at: string | null;
  sanity_check_notes: string | null;
  corroboration_count: number;
  contradiction_count: number;
  status: ChallengeStatus;
  admin_notification_sent_at: string[];
  admin_notification_metadata: unknown[];
  notification_failure_count: number;
  time_decay_at: string;
  resolved_at: string | null;
  resolution_notes: string | null;
  admin_overridden_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateChallengeInput {
  canonicalPlanId: string;
  serviceSlug: string | null;
  fieldName: string;
  benefitCorrectionId: string | null;
  proposedValue: unknown;
  proposedByUserId: string;
}

export interface CreateChallengeResult {
  challengeId: string | null;
  error: { message: string } | null;
}

/**
 * Step 1a — Create a new correction challenge row with status='pending_sanity_check'.
 *
 * Computes time_decay_at from canonical_promotion_event_v1.config.challenge_time_decay_days
 * (default 90 per Q-P4.0.6-5 LOCK). Triggers admin notification 'submitted' event.
 *
 * Caller (typically the benefit_corrections submission handler in API route) is
 * responsible for invoking runChallengeSanityCheck() in a follow-up step once the
 * user's document has been re-parsed.
 */
export async function createCorrectionChallenge(
  supabase: SupabaseClient,
  input: CreateChallengeInput,
): Promise<CreateChallengeResult> {
  // Read time-decay config from feature flag
  const { data: flagRow, error: flagError } = await supabase
    .from("feature_flag_rules")
    .select("config")
    .eq("flag_key", "canonical_promotion_event_v1")
    .single();

  if (flagError) {
    return { challengeId: null, error: { message: `read flag config: ${flagError.message}` } };
  }
  const decayDays =
    (flagRow?.config as Record<string, unknown> | null)?.challenge_time_decay_days as
      | number
      | undefined;
  const days = typeof decayDays === "number" && decayDays > 0 ? decayDays : 90;
  const timeDecayAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  // Insert row
  const { data, error } = await supabase
    .from("canonical_correction_challenges")
    .insert({
      canonical_plan_id: input.canonicalPlanId,
      service_slug: input.serviceSlug,
      field_name: input.fieldName,
      benefit_correction_id: input.benefitCorrectionId,
      proposed_value: input.proposedValue,
      proposed_by_user_id: input.proposedByUserId,
      status: "pending_sanity_check",
      time_decay_at: timeDecayAt,
    })
    .select("id")
    .single();

  if (error || !data) {
    return { challengeId: null, error: { message: error?.message ?? "no row returned" } };
  }

  // Fire admin notification (stub; Task 4.0.6-K replaces with Slack + email + queue)
  await enqueueChallengeNotification(supabase, data.id, "submitted");

  return { challengeId: data.id, error: null };
}

export interface SanityCheckInput {
  /** TRUE if user's own document supports the proposed value; FALSE otherwise. */
  passed: boolean;
  /** Optional notes (e.g. "user OCR matches proposed value at section X"). */
  notes?: string;
}

export interface SanityCheckResult {
  newStatus: ChallengeStatus;
  error: { message: string } | null;
}

/**
 * Step 1b — Run sanity check on a pending challenge.
 *
 * Caller computes whether the user's own document supports the proposed_value
 * (typically via re-parsing the OCR for the corrected field section) and passes
 * the verdict here. This module updates the row + transitions status + fires
 * admin notification.
 *
 * Status transitions:
 *   pending_sanity_check → pending_corroboration  (sanity passed)
 *   pending_sanity_check → sanity_failed_admin_queue (sanity failed)
 */
export async function runChallengeSanityCheck(
  supabase: SupabaseClient,
  challengeId: string,
  result: SanityCheckInput,
): Promise<SanityCheckResult> {
  const newStatus: ChallengeStatus = result.passed
    ? "pending_corroboration"
    : "sanity_failed_admin_queue";

  const { error } = await supabase
    .from("canonical_correction_challenges")
    .update({
      sanity_check_passed: result.passed,
      sanity_check_at: new Date().toISOString(),
      sanity_check_notes: result.notes ?? null,
      status: newStatus,
      updated_at: new Date().toISOString(),
    })
    .eq("id", challengeId)
    .eq("status", "pending_sanity_check"); // guard: only transition from pending_sanity_check

  if (error) {
    return { newStatus, error: { message: error.message } };
  }

  await enqueueChallengeNotification(
    supabase,
    challengeId,
    result.passed ? "sanity_passed" : "sanity_failed",
  );

  return { newStatus, error: null };
}

export type ObservationOutcome =
  | "no_match"
  | "corroboration_recorded"
  | "contradiction_recorded"
  | "auto_resolved_corroborated"
  | "auto_resolved_contradicted";

export interface RecordObservationInput {
  /** Whether the new user's value matches the challenge's proposed_value (deep JSONB equality). */
  matchesProposed: boolean;
  /** Whether the new user's value matches the canonical_current_value (deep JSONB equality). */
  matchesCanonical: boolean;
}

export interface RecordObservationResult {
  outcome: ObservationOutcome;
  newStatus: ChallengeStatus | null;
  error: { message: string } | null;
}

/**
 * Step 2 — Record a corroboration or contradiction observation on a pending challenge.
 *
 * Called from commit-and-evaluate's checkAndUpdatePendingChallenges() helper when
 * a new user's first-parse observed value is compared against the challenge's
 * proposed_value and canonical_current_value:
 *
 *   matchesProposed  → corroboration_count++
 *   matchesCanonical → contradiction_count++
 *   neither (third value) → no_match (returned for telemetry; no count update)
 *
 * Auto-resolves if threshold met:
 *   corroboration_count >= threshold → status='corroborated' + fires
 *     value_corrected_via_challenge promotion event (canonical updated)
 *   contradiction_count >= threshold → status='contradicted' + canonical retains
 *     old value; correction stays user-scoped indefinitely
 *
 * Threshold from canonical_promotion_event_v1.config.corroboration_threshold (default 3).
 */
export async function recordChallengeObservation(
  supabase: SupabaseClient,
  challengeId: string,
  observation: RecordObservationInput,
): Promise<RecordObservationResult> {
  if (!observation.matchesProposed && !observation.matchesCanonical) {
    return { outcome: "no_match", newStatus: null, error: null };
  }

  // Read challenge + threshold config
  const [{ data: challenge, error: readError }, { data: flagRow, error: flagError }] =
    await Promise.all([
      supabase.from("canonical_correction_challenges").select("*").eq("id", challengeId).single(),
      supabase
        .from("feature_flag_rules")
        .select("config")
        .eq("flag_key", "canonical_promotion_event_v1")
        .single(),
    ]);

  if (readError || !challenge) {
    return {
      outcome: "no_match",
      newStatus: null,
      error: { message: `read challenge: ${readError?.message ?? "not found"}` },
    };
  }
  if (flagError) {
    return {
      outcome: "no_match",
      newStatus: null,
      error: { message: `read flag config: ${flagError.message}` },
    };
  }
  const threshold =
    ((flagRow?.config as Record<string, unknown> | null)?.corroboration_threshold as
      | number
      | undefined) ?? 3;

  const row = challenge as CorrectionChallengeRow;

  // Increment counts
  const newCorroborationCount = observation.matchesProposed
    ? row.corroboration_count + 1
    : row.corroboration_count;
  const newContradictionCount = observation.matchesCanonical
    ? row.contradiction_count + 1
    : row.contradiction_count;

  // Decide auto-resolution
  let newStatus: ChallengeStatus = row.status;
  let outcome: ObservationOutcome = observation.matchesProposed
    ? "corroboration_recorded"
    : "contradiction_recorded";

  if (newCorroborationCount >= threshold && row.status === "pending_corroboration") {
    newStatus = "corroborated";
    outcome = "auto_resolved_corroborated";
  } else if (newContradictionCount >= threshold) {
    newStatus = "contradicted";
    outcome = "auto_resolved_contradicted";
  }

  // Persist count + status update
  const { error: updateError } = await supabase
    .from("canonical_correction_challenges")
    .update({
      corroboration_count: newCorroborationCount,
      contradiction_count: newContradictionCount,
      status: newStatus,
      ...(newStatus === "corroborated" || newStatus === "contradicted"
        ? { resolved_at: new Date().toISOString() }
        : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", challengeId);

  if (updateError) {
    return {
      outcome,
      newStatus,
      error: { message: `update counts: ${updateError.message}` },
    };
  }

  // Fire admin notification for the observation event
  await enqueueChallengeNotification(
    supabase,
    challengeId,
    observation.matchesProposed ? "corroboration_added" : "contradiction_added",
  );

  // If auto-resolved corroborated → fire value_corrected_via_challenge promotion event
  if (newStatus === "corroborated") {
    const sources: import("./corroboration-evaluator").CorroboratorExcerpt[] = [
      {
        user_id_hash: row.proposed_by_user_id, // proposer counts as one corroborator
        excerpt: null,
        document_ref: row.benefit_correction_id ?? "challenge",
        recorded_at: row.created_at,
      },
    ];
    const { error: promoteError } = await applyPromotionEvent(
      supabase,
      row.canonical_plan_id,
      row.service_slug,
      row.field_name,
      row.proposed_value,
      sources,
      "correction-challenge-resolution",
      // Challenge resolution: no document excerpt (proposer's challenge, excerpt null) → admin_attested (N1).
      { cite: false, reason: "admin_attested" },
      { actorUserId: row.proposed_by_user_id },
    );
    if (promoteError) {
      // Don't fail the observation; log error but state machine has progressed
      console.error(
        `correction-challenge: promotion event for resolved challenge ${challengeId} failed: ${promoteError.message}`,
      );
    }

    await enqueueChallengeNotification(supabase, challengeId, "resolved_corroborated");
  } else if (newStatus === "contradicted") {
    await enqueueChallengeNotification(supabase, challengeId, "resolved_contradicted");
  }

  return { outcome, newStatus, error: null };
}

export type AdminResolution = "accept" | "dismiss" | "extend";

export interface AdminResolveInput {
  adminUserId: string;
  resolution: AdminResolution;
  notes?: string;
  /** For 'extend': new time_decay_at; ignored for accept/dismiss. */
  newTimeDecayAt?: string;
}

export interface AdminResolveResult {
  newStatus: ChallengeStatus;
  error: { message: string } | null;
}

/**
 * Step 3 — Admin override: accept / dismiss / extend a pending challenge.
 *
 * 'accept': admin force-accepts correction → status='admin_overridden' +
 *   fires value_corrected_via_challenge promotion event (skips corroboration);
 * 'dismiss': admin force-dismisses → status='admin_overridden' +
 *   canonical retains old value; correction stays user-scoped;
 * 'extend': admin pushes time_decay_at out by N days → status remains pending_*.
 */
export async function adminResolveChallenge(
  supabase: SupabaseClient,
  challengeId: string,
  input: AdminResolveInput,
): Promise<AdminResolveResult> {
  const { data: challenge, error: readError } = await supabase
    .from("canonical_correction_challenges")
    .select("*")
    .eq("id", challengeId)
    .single();

  if (readError || !challenge) {
    return {
      newStatus: "pending_sanity_check",
      error: { message: `read challenge: ${readError?.message ?? "not found"}` },
    };
  }
  const row = challenge as CorrectionChallengeRow;

  if (input.resolution === "extend") {
    const decayAt = input.newTimeDecayAt ?? new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    const { error } = await supabase
      .from("canonical_correction_challenges")
      .update({
        time_decay_at: decayAt,
        admin_overridden_by: input.adminUserId,
        resolution_notes: input.notes ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", challengeId);
    return { newStatus: row.status, error: error ? { message: error.message } : null };
  }

  // accept / dismiss
  const { error: updateError } = await supabase
    .from("canonical_correction_challenges")
    .update({
      status: "admin_overridden",
      resolved_at: new Date().toISOString(),
      admin_overridden_by: input.adminUserId,
      resolution_notes: input.notes ?? `admin ${input.resolution}`,
      updated_at: new Date().toISOString(),
    })
    .eq("id", challengeId);

  if (updateError) {
    return { newStatus: row.status, error: { message: updateError.message } };
  }

  if (input.resolution === "accept") {
    // Fire value_corrected_via_challenge promotion event using proposed_value
    const sources: import("./corroboration-evaluator").CorroboratorExcerpt[] = [
      {
        user_id_hash: row.proposed_by_user_id,
        excerpt: null,
        document_ref: row.benefit_correction_id ?? "challenge",
        recorded_at: row.created_at,
      },
    ];
    const { error: promoteError } = await applyPromotionEvent(
      supabase,
      row.canonical_plan_id,
      row.service_slug,
      row.field_name,
      row.proposed_value,
      sources,
      "admin-ui",
      // Admin-accept challenge: no document excerpt → admin_attested (N1).
      { cite: false, reason: "admin_attested" },
      { actorUserId: input.adminUserId },
    );
    if (promoteError) {
      console.error(
        `correction-challenge: admin-accept promotion event for ${challengeId} failed: ${promoteError.message}`,
      );
    }
  }

  await enqueueChallengeNotification(supabase, challengeId, "admin_overridden");

  return { newStatus: "admin_overridden", error: null };
}

export interface SweepResult {
  swept: number;
  error: { message: string } | null;
}

/**
 * Time-decay sweep — find pending challenges past time_decay_at; transition to
 * status='time_decayed' + fire admin notification. Run daily via QStash/pg_cron
 * (Task 4.0.6-F follow-up integration).
 *
 * Idempotent: only updates rows still in pending_* status.
 */
export async function sweepTimeDecayedChallenges(supabase: SupabaseClient): Promise<SweepResult> {
  const now = new Date().toISOString();

  const { data: rows, error: selectError } = await supabase
    .from("canonical_correction_challenges")
    .select("id")
    .in("status", ["pending_corroboration", "pending_contradiction"])
    .lt("time_decay_at", now);

  if (selectError) {
    return { swept: 0, error: { message: `select decayed: ${selectError.message}` } };
  }

  const ids = (rows ?? []).map((r) => r.id as string);
  if (ids.length === 0) return { swept: 0, error: null };

  const { error: updateError } = await supabase
    .from("canonical_correction_challenges")
    .update({
      status: "time_decayed",
      updated_at: now,
    })
    .in("id", ids);

  if (updateError) {
    return { swept: 0, error: { message: `update decayed: ${updateError.message}` } };
  }

  for (const id of ids) {
    await enqueueChallengeNotification(supabase, id, "time_decayed");
  }

  return { swept: ids.length, error: null };
}

export interface CheckPendingChallengesInput {
  canonicalPlanId: string;
  serviceSlug: string | null;
  fieldName: string;
  observedValue: unknown;
  canonicalCurrentValue: unknown;
}

export interface PendingChallengeUpdate {
  challengeId: string;
  outcome: ObservationOutcome;
  newStatus: ChallengeStatus | null;
}

export interface CheckPendingChallengesResult {
  updates: PendingChallengeUpdate[];
  errors: string[];
}

/**
 * Integration helper for `commit-and-evaluate.ts` — when a value mismatch is
 * observed (canonical at 0.9 + new value disagrees), check for pending challenges
 * on this (canonical, service, field) and update their corroboration vs
 * contradiction counts based on the new observation.
 *
 * Per Principles §8.2 active corroboration challenge architecture: subsequent
 * users' first-parse values are checked against pending corrections. This is
 * where that check happens.
 */
export async function checkAndUpdatePendingChallenges(
  supabase: SupabaseClient,
  input: CheckPendingChallengesInput,
): Promise<CheckPendingChallengesResult> {
  const result: CheckPendingChallengesResult = { updates: [], errors: [] };

  const { data: pendingRows, error } = await supabase
    .from("canonical_correction_challenges")
    .select("id, proposed_value")
    .eq("canonical_plan_id", input.canonicalPlanId)
    .eq("field_name", input.fieldName)
    .in("status", ["pending_corroboration", "pending_contradiction"])
    .or(
      input.serviceSlug === null
        ? "service_slug.is.null"
        : `service_slug.eq.${input.serviceSlug}`,
    );

  if (error) {
    result.errors.push(`select pending challenges: ${error.message}`);
    return result;
  }
  if (!pendingRows || pendingRows.length === 0) return result;

  const observedJson = stableJsonString(input.observedValue);
  const canonicalJson = stableJsonString(input.canonicalCurrentValue);

  for (const pending of pendingRows) {
    const proposedJson = stableJsonString((pending as Record<string, unknown>).proposed_value);
    const matchesProposed = observedJson === proposedJson;
    const matchesCanonical = observedJson === canonicalJson;

    const { outcome, newStatus, error: updateError } = await recordChallengeObservation(
      supabase,
      pending.id as string,
      { matchesProposed, matchesCanonical },
    );

    if (updateError) {
      result.errors.push(`update challenge ${pending.id}: ${updateError.message}`);
      continue;
    }

    result.updates.push({ challengeId: pending.id as string, outcome, newStatus });
  }

  return result;
}

/**
 * Admin notification dispatch — Task 4.0.6-K wires the real implementation per
 * Q-P4.0.6-6 LOCK v4 (Slack + queue + email-bookend + Slack-failure fallback).
 * Delegates to `@/lib/notifications/canonical-promotion-notifications`.
 */
async function enqueueChallengeNotification(
  supabase: SupabaseClient,
  challengeId: string,
  event: ChallengeNotificationEvent,
): Promise<void> {
  await sendChallengeNotificationV1(supabase, challengeId, event);
}

/** Stable JSON serialization for deep equality comparison of JSONB values. */
function stableJsonString(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${(value as unknown[]).map(stableJsonString).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJsonString(v)}`).join(",")}}`;
}
