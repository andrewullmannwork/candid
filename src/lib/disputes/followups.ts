/**
 * Dispute Follow-ups — timed prompts for dispute outcome tracking.
 *
 * After a user files a dispute, the system creates follow-up reminders:
 * - 30 days: "What happened with your dispute?" (initial_30d)
 * - If "still waiting": 14-day reprompt (reprompt_14d)
 * - After second reprompt: final prompt (final)
 *
 * Outcomes feed accuracy scoring (Phase 2B) and escalation routing (Phase 2C).
 *
 * T2.2 v3 (Session 62): cadence read from dispute_feedback_loop.config JSONB
 * (admin-tunable; defaults preserve existing 30/14/14 behavior). Per Q-T2.2-2 LOCK.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { userScoped } from "@/lib/security/user-scoped";
import { readDeadlineConfig, computeFollowupSchedule } from "@/lib/disputes/deadline-engine";
import { buildFollowupLetter } from "@/lib/disputes/followup-letter";
import { letterRecipientKind } from "@/lib/disputes";
import type { DisputeLetterType } from "@/lib/billing/types";

const DEFAULT_FIRST_DAYS = 30;
const DEFAULT_REPEAT_DAYS = 14;

interface FollowupCadence {
  firstDays: number;
  repeatDays: number;
}

async function readCadence(supabase: SupabaseClient): Promise<FollowupCadence> {
  try {
    const { data } = await supabase
      .from("feature_flag_rules")
      .select("config")
      .eq("flag_key", "dispute_feedback_loop")
      .maybeSingle();
    const cfg = (data?.config as Record<string, unknown> | undefined) ?? {};
    const first = cfg.follow_up_first_days;
    const repeat = cfg.follow_up_repeat_days;
    return {
      firstDays: typeof first === "number" && first > 0 ? first : DEFAULT_FIRST_DAYS,
      repeatDays: typeof repeat === "number" && repeat > 0 ? repeat : DEFAULT_REPEAT_DAYS,
    };
  } catch {
    return { firstDays: DEFAULT_FIRST_DAYS, repeatDays: DEFAULT_REPEAT_DAYS };
  }
}

function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

export type FollowupType =
  | "initial_30d"
  | "reprompt_14d"
  | "final"
  | "post_escalation_60d"
  | "post_escalation_reprompt_30d";

export type FollowupStatus = "pending" | "shown" | "dismissed" | "acted";

export interface FollowupRow {
  id: string;
  dispute_id: string;
  user_id: string;
  followup_type: FollowupType;
  due_date: string;
  status: FollowupStatus;
  escalation_type: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ActiveFollowup extends FollowupRow {
  dispute: {
    id: string;
    dispute_type: string;
    status: string;
    amount_disputed: number;
    filed_date: string;
    insurer_name?: string;
    service_slug?: string;
    // S297 (Andrew E2E #1) — which BILL this follow-up is about, so the
    // banner can say so and deeplink. Additive; null when unresolvable.
    claim_id?: string | null;
    provider_name?: string | null;
    // S300 phase 2b — the per-letter governing deadline, so the per-claim
    // banner row can name the SOONEST one. Null when the deadline engine
    // never resolved a governing date for that letter.
    governing_deadline_date?: string | null;
  };
}

/**
 * S300 phase 2b (agenda §0.9c) — ONE CLAIM PER POINTER.
 *
 * The banner is a STANDING PER-CLAIM ROW, not an event: one row per bill,
 * one button to that claim's rail top. Grouping happens HERE (server-side,
 * pure) rather than in the banner, because a client-side grouping would be a
 * second place deriving case state — the drift class S298's letter-type
 * consolidation killed.
 *
 * Followups whose dispute has no resolvable `claim_id` are DROPPED, not
 * bucketed under a null key: the row's only affordance is a claim deeplink,
 * so a claim-less row would render a button that goes nowhere.
 */
export interface ClaimFollowupGroup {
  claimId: string;
  providerName: string | null;
  /** Distinct LETTERS waiting on this claim (not follow-up rows — a letter with
   *  an interim + final nudge pending is still ONE letter waiting). */
  letterCount: number;
  /** Soonest governing deadline across this claim's waiting letters (YYYY-MM-DD), or null. */
  nextDeadline: string | null;
  /** Every due follow-up id on this claim — the claim-scoped dismiss acts on all of them. */
  followupIds: string[];
}

export function groupFollowupsByClaim(rows: ActiveFollowup[]): ClaimFollowupGroup[] {
  const byClaim = new Map<string, { group: ClaimFollowupGroup; disputeIds: Set<string> }>();
  // Input order is due_date ASC (getActiveFollowups) — preserved, so the claim
  // with the most urgent nudge leads the banner.
  for (const row of rows) {
    const claimId = row.dispute.claim_id;
    if (typeof claimId !== "string" || claimId.length === 0) continue;
    let entry = byClaim.get(claimId);
    if (!entry) {
      entry = {
        group: {
          claimId,
          providerName: row.dispute.provider_name ?? null,
          letterCount: 0,
          nextDeadline: null,
          followupIds: [],
        },
        disputeIds: new Set<string>(),
      };
      byClaim.set(claimId, entry);
    }
    entry.disputeIds.add(row.dispute.id);
    entry.group.followupIds.push(row.id);
    if (entry.group.providerName === null && row.dispute.provider_name) {
      entry.group.providerName = row.dispute.provider_name;
    }
    const deadline = row.dispute.governing_deadline_date;
    if (typeof deadline === "string" && deadline.length > 0) {
      // Date-only strings compare correctly as strings (YYYY-MM-DD) — no clock,
      // no timezone, which is the point (the S299 letter-date rule).
      if (entry.group.nextDeadline === null || deadline < entry.group.nextDeadline) {
        entry.group.nextDeadline = deadline;
      }
    }
  }
  return [...byClaim.values()].map(({ group, disputeIds }) => ({
    ...group,
    letterCount: disputeIds.size,
  }));
}

/**
 * Create the initial follow-up after a dispute is filed.
 * Cadence read from dispute_feedback_loop.config.follow_up_first_days (default 30).
 * Called from persist.ts when dispute_feedback_loop flag is enabled.
 */
export async function createFollowups(
  supabase: SupabaseClient,
  params: {
    disputeId: string;
    userId: string;
    // dispute-letters v2 S4 — when a governing deadline is present (the generate route supplies it
    // ONLY while dispute_deadline_engine_v1 is ON), schedule graduated deadline-anchored follow-up
    // LETTERS (map §3.3) instead of the flat 30/14 cadence.
    letterType?: string;
    filedDate?: string;
    deadline?: { governingDeadlineDate: string | null; deadlineType: string | null };
  }
): Promise<void> {
  const { disputeId, userId } = params;

  // Graduated deadline follow-ups (map §3.3). Presence of a governing deadline is the signal.
  if (params.deadline?.governingDeadlineDate && params.deadline.deadlineType && params.letterType) {
    await createDeadlineFollowups(supabase, {
      disputeId,
      userId,
      letterType: params.letterType,
      filedDate: params.filedDate,
      governingDeadlineDate: params.deadline.governingDeadlineDate,
      deadlineType: params.deadline.deadlineType,
    });
    return;
  }

  // Default (no governing deadline / engine flag OFF) — the existing single initial follow-up.
  const { firstDays } = await readCadence(supabase);
  const dueDate = addDays(firstDays);

  await userScoped(supabase, userId).table("dispute_followups").insert({
    dispute_id: disputeId,
    followup_type: "initial_30d",
    due_date: dueDate,
    status: "pending",
  });

  console.log(`[followups] Created ${firstDays}-day follow-up for dispute ${disputeId}, due ${dueDate}`);
}

/**
 * Surface 4 (clarity redesign) — key the flat-cadence reminder clock to the
 * SEND, not the draft. createFollowups() schedules the initial reminder at
 * draft time (filed_date = creation date); when the user marks the letter
 * sent we reschedule the still-pending `initial_30d` row to sent + firstDays
 * so "Mark it as sent — starts the clock" is literally true. If no pending
 * initial reminder exists (pre-flag dispute or already fired), one is created
 * keyed to the send. Deadline-anchored follow-ups (deadline engine ON) are
 * NOT touched — their schedule keys off the governing deadline, which is
 * already send-independent.
 */
export async function rescheduleInitialFollowupOnSent(
  supabase: SupabaseClient,
  params: { disputeId: string; userId: string; sentDate: Date },
): Promise<void> {
  const { disputeId, userId, sentDate } = params;
  const { firstDays } = await readCadence(supabase);
  const due = new Date(sentDate);
  due.setDate(due.getDate() + firstDays);
  const dueDate = due.toISOString().split("T")[0];

  const { data: pending } = await userScoped(supabase, userId)
    .table("dispute_followups")
    .select("id")
    .eq("dispute_id", disputeId)
    .eq("followup_type", "initial_30d")
    .eq("status", "pending")
    .maybeSingle();

  if (pending) {
    await userScoped(supabase, userId)
      .table("dispute_followups")
      .update({ due_date: dueDate, updated_at: new Date().toISOString() })
      .eq("id", pending.id);
    console.log(`[followups] Rescheduled initial follow-up for dispute ${disputeId} to ${dueDate} (mark-sent)`);
    return;
  }

  await userScoped(supabase, userId).table("dispute_followups").insert({
    dispute_id: disputeId,
    followup_type: "initial_30d",
    due_date: dueDate,
    status: "pending",
  });
  console.log(`[followups] Created sent-keyed follow-up for dispute ${disputeId}, due ${dueDate}`);
}

/**
 * dispute-letters v2 S4 — schedule the graduated deadline follow-up LETTERS (map §3.3). Each row
 * carries its rendered Appeals/Compliance/collector-addressed nudge in metadata (the existing
 * send-followups cron surfaces it; the letter itself is read on the S5/S6 case page). Reuses the
 * existing followup_type values + a metadata.followup_kind discriminator (no CHECK change) —
 * handleFollowupAction skips the reactive reprompt chain for these (they're pre-scheduled in full).
 */
async function createDeadlineFollowups(
  supabase: SupabaseClient,
  params: {
    disputeId: string;
    userId: string;
    letterType: string;
    filedDate?: string;
    governingDeadlineDate: string;
    deadlineType: string;
  },
): Promise<void> {
  const { disputeId, userId, letterType, governingDeadlineDate, deadlineType } = params;
  const config = await readDeadlineConfig(supabase);
  const schedule = computeFollowupSchedule(governingDeadlineDate, config);
  if (!schedule.length) {
    console.log(
      `[followups] No graduated follow-ups for dispute ${disputeId} (deadline ${governingDeadlineDate} too close)`,
    );
    return;
  }

  const recipientKind = letterRecipientKind(letterType as DisputeLetterType);
  const parentSentDate = params.filedDate ?? new Date().toISOString().split("T")[0];
  const rows = schedule.map((entry) => ({
    dispute_id: disputeId,
    // Reuse existing enum values (no CHECK change); the real semantic rides in metadata.followup_kind.
    followup_type: entry.kind === "deadline_final" ? "final" : "reprompt_14d",
    due_date: entry.dueDate,
    status: "pending",
    metadata: {
      followup_kind: entry.kind,
      letter: buildFollowupLetter({
        recipientKind,
        parentLetterType: letterType,
        parentSentDate,
        governingDeadlineDate,
        deadlineType,
        isFinal: entry.kind === "deadline_final",
      }),
      governing_deadline_date: governingDeadlineDate,
      deadline_type: deadlineType,
      parent_letter_type: letterType,
    },
  }));

  await userScoped(supabase, userId).table("dispute_followups").insert(rows);
  console.log(
    `[followups] Created ${rows.length} graduated deadline follow-up(s) for dispute ${disputeId} (deadline ${governingDeadlineDate})`,
  );
}

/**
 * Get all active follow-ups for a user (due today or earlier, still pending).
 * Returns follow-ups enriched with dispute context.
 */
export async function getActiveFollowups(
  supabase: SupabaseClient,
  userId: string
): Promise<ActiveFollowup[]> {
  const today = new Date().toISOString().split("T")[0];

  const { data, error } = await userScoped(supabase, userId)
    .table("dispute_followups")
    .select(
      "*, dispute_outcomes!inner(id, dispute_type, status, amount_disputed, filed_date, claim_id, governing_deadline_date, metadata)",
    )
    .eq("status", "pending")
    .lte("due_date", today)
    .order("due_date", { ascending: true });

  if (error || !data) return [];

  // S297 (Andrew E2E #1) — resolve each follow-up's bill so the banner can
  // name it. One batched owner-scoped read; absent/failed → null (banner
  // degrades to today's copy, never blocks).
  const claimIds = Array.from(
    new Set(
      data
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((row) => (row.dispute_outcomes as any)?.claim_id as string | null)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );
  const providerByClaim = new Map<string, string>();
  if (claimIds.length > 0) {
    const { data: claimRows } = await userScoped(supabase, userId)
      .table("claims")
      .select("id, metadata")
      .in("id", claimIds);
    for (const c of (claimRows ?? []) as Array<{ id: string; metadata: unknown }>) {
      const name = ((c.metadata as Record<string, unknown> | null)?.provider as
        | Record<string, unknown>
        | undefined)?.name;
      if (typeof name === "string" && name.trim().length > 0) providerByClaim.set(c.id, name);
    }
  }

  return data.map((row) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dispute = row.dispute_outcomes as any;
    const claimId = (dispute.claim_id as string | null) ?? null;
    return {
      ...row,
      dispute: {
        id: dispute.id,
        dispute_type: dispute.dispute_type,
        status: dispute.status,
        amount_disputed: dispute.amount_disputed,
        filed_date: dispute.filed_date,
        claim_id: claimId,
        provider_name: claimId ? (providerByClaim.get(claimId) ?? null) : null,
        governing_deadline_date: (dispute.governing_deadline_date as string | null) ?? null,
      },
    };
  });
}

/**
 * S300 phase 2b — what a LOGGED OUTCOME does to that letter's pending nudges.
 *
 * The banner becomes a pure pointer (§0.9c), so its "Still waiting" button —
 * today the only thing that advances the initial→reprompt→final chain — goes
 * away. That escape hatch has to move to where the fact is actually recorded,
 * or a user who logs "they asked for more information" keeps being asked "did
 * you hear back?" forever (5 of 9 outcome details map to `in_progress`, so
 * persist.ts's RESOLVED_STATUSES sweep never fires for them).
 *
 * The rule RE-ANCHORS, it does not kill:
 *  - terminal outcomes      → untouched here; persist.ts already dismisses ALL
 *                             pending rows (case closed, outcome captured).
 *  - `no_response`          → advance the chain exactly as the old "Still
 *                             waiting" button did (they genuinely haven't heard).
 *  - other OPEN outcomes    → dismiss the STALE nudge and schedule the next
 *                             rung from today. The user stops being asked a
 *                             question they answered, and the flywheel still
 *                             comes back for the outcome that matters. Killing
 *                             the chain outright would go dark on every case
 *                             that stays open — a flywheel regression.
 *
 * DEADLINE-anchored rows (`metadata.followup_kind` = `deadline_*`) are NEVER
 * touched: a legal deadline exists whether or not the counterparty wrote back.
 * Only resolution or the deadline passing ends those.
 *
 * Fail-soft (mirrors its call site's neighbours) — a failed re-anchor loses a
 * future nudge, never the outcome write that preceded it.
 */
const OPEN_OUTCOME_NEXT_TYPE: Partial<Record<FollowupType, FollowupType>> = {
  initial_30d: "reprompt_14d",
  reprompt_14d: "final",
  // `final` is the end of the cadence — re-anchoring stops here by design.
};

/** The check-in cadence, in order. Deadline rows are NOT part of it. */
const CHECK_IN_ORDER: FollowupType[] = ["initial_30d", "reprompt_14d", "final"];

export interface PendingFollowupRow {
  id: string;
  followup_type: FollowupType;
  metadata: Record<string, unknown> | null;
}

export interface FollowupQuietingPlan {
  /** Rows to mark dismissed (never deadline-anchored ones). */
  dismissIds: string[];
  /** The rung to schedule from today, or null when the cadence is exhausted. */
  nextType: FollowupType | null;
}

/**
 * PURE decision half of {@link quietOutcomeFollowups} — exercised by
 * scripts/calibration/fixtures/dispute-grounds/followup-quieting.ts.
 */
export function planFollowupQuieting(
  pending: PendingFollowupRow[],
  outcomeDetail: string,
): FollowupQuietingPlan {
  // Check-in chain only — a legal deadline exists whether or not the
  // counterparty wrote back.
  const checkIn = pending.filter((r) => {
    const kind = r.metadata?.followup_kind;
    return !(typeof kind === "string" && kind.startsWith("deadline_"));
  });
  if (checkIn.length === 0) return { dismissIds: [], nextType: null };

  // Nothing arrived — the existing reactive chain is already right. Leave the
  // rows alone; the cron re-nudges on their own cadence.
  if (outcomeDetail === "no_response") return { dismissIds: [], nextType: null };

  // Re-anchor from the FURTHEST-ALONG row being dismissed, so an answered
  // reprompt escalates to final rather than looping back to another reprompt.
  const furthest = checkIn
    .map((r) => r.followup_type)
    .filter((t) => CHECK_IN_ORDER.includes(t))
    .sort((a, b) => CHECK_IN_ORDER.indexOf(a) - CHECK_IN_ORDER.indexOf(b))
    .pop();
  return {
    dismissIds: checkIn.map((r) => r.id),
    nextType: furthest ? (OPEN_OUTCOME_NEXT_TYPE[furthest] ?? null) : null,
  };
}

export async function quietOutcomeFollowups(
  supabase: SupabaseClient,
  params: { disputeId: string; userId: string; outcomeDetail: string },
): Promise<void> {
  const { disputeId, userId, outcomeDetail } = params;
  try {
    const { data: rows } = await userScoped(supabase, userId)
      .table("dispute_followups")
      .select("id, followup_type, metadata")
      .eq("dispute_id", disputeId)
      .eq("status", "pending");

    const plan = planFollowupQuieting((rows ?? []) as PendingFollowupRow[], outcomeDetail);
    if (plan.dismissIds.length === 0) return;

    await userScoped(supabase, userId)
      .table("dispute_followups")
      .update({ status: "dismissed", updated_at: new Date().toISOString() })
      .in("id", plan.dismissIds);

    if (!plan.nextType) return;
    const { repeatDays } = await readCadence(supabase);
    await userScoped(supabase, userId).table("dispute_followups").insert({
      dispute_id: disputeId,
      followup_type: plan.nextType,
      due_date: addDays(repeatDays),
      status: "pending",
    });
  } catch (err) {
    console.error("[followups] quietOutcomeFollowups failed (non-fatal):", err);
  }
}

/**
 * Handle a user's response to a follow-up prompt.
 *
 * Actions:
 * - "won" / "settled" / "lost": mark dispute with outcome, create no more follow-ups
 * - "still_waiting": dismiss current, create 14-day reprompt (or final if already reprompted)
 * - "dismiss": just dismiss, no further action
 */
export async function handleFollowupAction(
  supabase: SupabaseClient,
  params: {
    followupId: string;
    userId: string;
    action: "won" | "settled" | "lost" | "still_waiting" | "dismiss";
    amountRecovered?: number;
  }
): Promise<{ success: boolean; nextFollowupCreated?: boolean }> {
  const { followupId, userId, action, amountRecovered } = params;

  // Fetch the follow-up and verify ownership
  const { data: followup, error } = await userScoped(supabase, userId)
    .table("dispute_followups")
    .select("id, dispute_id, followup_type, status, metadata")
    .eq("id", followupId)
    .single();

  if (error || !followup) return { success: false };

  // Mark this follow-up as acted
  await userScoped(supabase, userId)
    .table("dispute_followups")
    .update({ status: "acted", updated_at: new Date().toISOString() })
    .eq("id", followupId);

  // Handle outcome actions — update the dispute itself
  if (action === "won" || action === "settled" || action === "lost") {
    const updateData: Record<string, unknown> = {
      status: action,
      resolution_date: new Date().toISOString().split("T")[0],
    };
    if (amountRecovered !== undefined && (action === "won" || action === "settled")) {
      updateData.amount_recovered = amountRecovered;
    }

    await userScoped(supabase, userId)
      .table("dispute_outcomes")
      .update(updateData)
      .eq("id", followup.dispute_id);

    // Cancel any other pending follow-ups for this dispute
    await userScoped(supabase, userId)
      .table("dispute_followups")
      .update({ status: "dismissed", updated_at: new Date().toISOString() })
      .eq("dispute_id", followup.dispute_id)
      .eq("status", "pending")
      .neq("id", followupId);

    return { success: true, nextFollowupCreated: false };
  }

  // "still_waiting" — create next follow-up
  if (action === "still_waiting") {
    // dispute-letters v2 S4 — graduated deadline follow-ups are PRE-SCHEDULED in full (⅓/⅔/final),
    // so "still waiting" on one is terminal: do NOT spawn a reactive reprompt (would double-book the
    // timer). Non-deadline follow-ups keep the existing reactive initial→reprompt→final chain.
    const meta = ((followup as { metadata?: Record<string, unknown> | null }).metadata) ?? {};
    if (typeof meta.followup_kind === "string" && meta.followup_kind.startsWith("deadline_")) {
      return { success: true, nextFollowupCreated: false };
    }

    const isInitial = followup.followup_type === "initial_30d";
    const isReprompt = followup.followup_type === "reprompt_14d";

    const { repeatDays } = await readCadence(supabase);

    if (isInitial) {
      // Create reprompt (admin-tunable cadence)
      const dueDate = addDays(repeatDays);

      await userScoped(supabase, userId).table("dispute_followups").insert({
        dispute_id: followup.dispute_id,
        followup_type: "reprompt_14d",
        due_date: dueDate,
        status: "pending",
      });

      return { success: true, nextFollowupCreated: true };
    }

    if (isReprompt) {
      // Create final follow-up (admin-tunable cadence; same repeat interval)
      const dueDate = addDays(repeatDays);

      await userScoped(supabase, userId).table("dispute_followups").insert({
        dispute_id: followup.dispute_id,
        followup_type: "final",
        due_date: dueDate,
        status: "pending",
      });

      return { success: true, nextFollowupCreated: true };
    }

    // Final — no more follow-ups, just mark as acted
    return { success: true, nextFollowupCreated: false };
  }

  // "dismiss" — just mark as dismissed (already marked as acted above, update to dismissed)
  if (action === "dismiss") {
    await userScoped(supabase, userId)
      .table("dispute_followups")
      .update({ status: "dismissed", updated_at: new Date().toISOString() })
      .eq("id", followupId);
  }

  return { success: true };
}

/**
 * Create a post-escalation follow-up (60-day timer).
 * Called when a user escalates to Candid Case or small claims (Phase 2C).
 */
export async function createPostEscalationFollowup(
  supabase: SupabaseClient,
  params: {
    disputeId: string;
    userId: string;
    escalationType: "case" | "small_claims" | "external_appeal";
  }
): Promise<void> {
  const { disputeId, userId, escalationType } = params;

  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 60);

  await userScoped(supabase, userId).table("dispute_followups").insert({
    dispute_id: disputeId,
    followup_type: "post_escalation_60d",
    due_date: dueDate.toISOString().split("T")[0],
    status: "pending",
    escalation_type: escalationType,
  });

  console.log(`[followups] Created post-escalation follow-up (${escalationType}) for dispute ${disputeId}`);
}
