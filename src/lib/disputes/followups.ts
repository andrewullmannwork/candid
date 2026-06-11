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
  };
}

/**
 * Create the initial follow-up after a dispute is filed.
 * Cadence read from dispute_feedback_loop.config.follow_up_first_days (default 30).
 * Called from persist.ts when dispute_feedback_loop flag is enabled.
 */
export async function createFollowups(
  supabase: SupabaseClient,
  params: { disputeId: string; userId: string }
): Promise<void> {
  const { disputeId, userId } = params;
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
    .select("*, dispute_outcomes!inner(id, dispute_type, status, amount_disputed, filed_date, metadata)")
    .eq("status", "pending")
    .lte("due_date", today)
    .order("due_date", { ascending: true });

  if (error || !data) return [];

  return data.map((row) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dispute = row.dispute_outcomes as any;
    return {
      ...row,
      dispute: {
        id: dispute.id,
        dispute_type: dispute.dispute_type,
        status: dispute.status,
        amount_disputed: dispute.amount_disputed,
        filed_date: dispute.filed_date,
      },
    };
  });
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
    .select("id, dispute_id, followup_type, status")
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
