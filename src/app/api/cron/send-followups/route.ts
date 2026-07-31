/**
 * GET /api/cron/send-followups — Daily cron to send dispute follow-up emails
 *
 * Queries pending follow-ups where due_date <= today.
 * For each, sends email via notifyDisputeFollowup() and marks as "shown".
 * Vercel Cron compatible (GET request).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { isAuthorizedCron } from "@/lib/security/require-cron-secret";
import { userScoped } from "@/lib/security/user-scoped";
import { emitCaseEvent } from "@/lib/case/case-events";

export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();
  const today = new Date().toISOString().split("T")[0];

  // Get all pending follow-ups due today or earlier
  const { data: followups, error } = await supabase
    .from("dispute_followups")
    .select("id, dispute_id, user_id, followup_type")
    .eq("status", "pending")
    .lte("due_date", today)
    .limit(100);

  if (error || !followups || followups.length === 0) {
    return NextResponse.json({ sent: 0 });
  }

  const { notifyDisputeFollowup } = await import("@/lib/disputes/followup-notifications");
  let sent = 0;

  for (const followup of followups) {
    try {
      // Fetch dispute details
      const { data: dispute } = await supabase
        .from("dispute_outcomes")
        .select("id, claim_id, dispute_type, status, amount_disputed, filed_date")
        .eq("id", followup.dispute_id)
        .single();

      if (!dispute) continue;

      // Skip if dispute is already resolved (check status, not dispute_type)
      if (["won", "lost", "settled", "withdrawn", "won_on_escalation", "settled_on_escalation"].includes(dispute.status)) {
        await supabase.from("dispute_followups").update({ status: "dismissed" }).eq("id", followup.id);
        continue;
      }

      // Fetch user email
      const { data: user } = await supabase
        .from("users")
        .select("email")
        .eq("id", followup.user_id)
        .single();

      if (!user?.email) continue;

      // Send notification
      await notifyDisputeFollowup({
        userEmail: user.email,
        disputeId: dispute.id,
        disputeType: dispute.dispute_type,
        amountDisputed: dispute.amount_disputed,
        filedDate: dispute.filed_date,
        followupType: followup.followup_type,
      });

      // Mark as shown
      await supabase
        .from("dispute_followups")
        .update({ status: "shown", updated_at: new Date().toISOString() })
        .eq("id", followup.id);

      sent++;

      // Timeline unification Phase 0 (S298, mig 221) — the nudge, on the
      // record. Flag-gated + fail-soft inside the emitter.
      if (dispute.claim_id) {
        await emitCaseEvent(supabase, followup.user_id, {
          claimId: dispute.claim_id as string,
          disputeId: dispute.id as string,
          kind: "followup_sent",
          actor: "system",
          payload: { followupType: followup.followup_type },
        });
      }
    } catch (err) {
      console.error(`[cron/send-followups] Failed for followup ${followup.id}:`, err);
    }
  }

  // Timeline unification Phase 0 (S298, mig 221) — deadline_lapsed detection.
  // Sent, still-open disputes whose governing deadline has passed get one
  // system event (the once-only guard is an existing-event check, so cron
  // re-runs and retries never double-emit). Detection time is occurred_at;
  // the deadline itself rides the payload. Fail-soft end to end.
  try {
    const { data: lapsed } = await supabase
      .from("dispute_outcomes")
      .select("id, claim_id, user_id, governing_deadline_date, deadline_type, status")
      .not("sent_at", "is", null)
      .not("governing_deadline_date", "is", null)
      .lt("governing_deadline_date", today)
      .not("status", "in", "(won,lost,settled,withdrawn,won_on_escalation,settled_on_escalation,cancelled)")
      .limit(100);
    for (const d of lapsed ?? []) {
      if (!d.claim_id || !d.user_id) continue;
      const { data: already } = await userScoped(supabase, d.user_id as string)
        .table("claim_case_events")
        .select("id")
        .eq("dispute_id", d.id)
        .eq("kind", "deadline_lapsed")
        .limit(1);
      if (already && already.length > 0) continue;
      await emitCaseEvent(supabase, d.user_id as string, {
        claimId: d.claim_id as string,
        disputeId: d.id as string,
        kind: "deadline_lapsed",
        actor: "system",
        payload: {
          governingDeadlineDate: d.governing_deadline_date,
          deadlineType: d.deadline_type,
        },
      });
    }
  } catch (err) {
    console.error("[cron/send-followups] deadline_lapsed sweep failed (non-fatal):", err);
  }

  console.log(`[cron/send-followups] Sent ${sent}/${followups.length} follow-up notifications`);
  return NextResponse.json({ sent, total: followups.length });
}
