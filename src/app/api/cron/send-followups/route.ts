/**
 * GET /api/cron/send-followups — Daily cron to send dispute follow-up emails
 *
 * Queries pending follow-ups where due_date <= today.
 * For each, sends email via notifyDisputeFollowup() and marks as "shown".
 * Vercel Cron compatible (GET request).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

export async function GET(req: NextRequest) {
  // Verify cron secret (Vercel Cron sets this header)
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
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
        .select("id, dispute_type, status, amount_disputed, filed_date")
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
    } catch (err) {
      console.error(`[cron/send-followups] Failed for followup ${followup.id}:`, err);
    }
  }

  console.log(`[cron/send-followups] Sent ${sent}/${followups.length} follow-up notifications`);
  return NextResponse.json({ sent, total: followups.length });
}
