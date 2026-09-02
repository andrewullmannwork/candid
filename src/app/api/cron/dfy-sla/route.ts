/**
 * GET /api/cron/dfy-sla — the operator SLA watch (S330), daily. Fail-closed
 * cron auth like every cron. For each live engagement the queue's own summary
 * is computed (one derivation) and slaFlags() decides who needs a nudge: a
 * Slack line to backend-ops and an email to the holder (Resend, fail-soft).
 * Flag OFF = nothing to watch; answers { flagged: 0 }.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { isAuthorizedCron } from "@/lib/security/require-cron-secret";
import { readDfyState } from "@/lib/dfy/config";
import { DFY_ENGAGEMENT_COLUMNS, parseEngagementRow, type DfyEngagementRow } from "@/lib/security/operator-scoped";
import { loadMatterSummary, loadUsersDisplay } from "@/lib/dfy/matter";
import { slaFlags } from "@/lib/dfy/sla";
import { postOpsMessage } from "@/lib/slack/ops-message";
import { sendDfyOperatorSlaEmail } from "@/lib/email/dfy-emails";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://www.candidclaim.com";

export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const supabase = createServerClient();
  const state = await readDfyState(supabase);
  if (!state.enabled) return NextResponse.json({ flagged: 0, reason: "flag_off" });

  const { data } = await supabase.from("dfy_engagements").select(DFY_ENGAGEMENT_COLUMNS).in("status", ["signed", "active"]);
  const engagements = ((data ?? []) as unknown[]).map(parseEngagementRow).filter((e): e is DfyEngagementRow => e !== null);
  if (engagements.length === 0) return NextResponse.json({ flagged: 0 });
  const users = await loadUsersDisplay(supabase, engagements.flatMap((e) => [e.user_id, ...(e.operator_user_id ? [e.operator_user_id] : [])]));
  const now = new Date();
  const summaries = await Promise.all(engagements.map((e) => loadMatterSummary(supabase, e, { now, users })));
  const flags = slaFlags(summaries, state.config, now);
  if (flags.length === 0) return NextResponse.json({ flagged: 0, checked: engagements.length });

  const lines = flags.map((f) => `• matter ${f.engagementId.slice(0, 8)} (${f.holderUserId ? users.get(f.holderUserId)?.email ?? "holder" : "UNCLAIMED"}): ${f.reasons.join("; ")} — ${APP_URL}/admin/dfy/${f.engagementId}`);
  await postOpsMessage(`⏱ DFY operator SLA — ${flags.length} matter(s) need attention\n${lines.join("\n")}`, { channel: state.config.opsChannelId ?? undefined });
  const byHolder = new Map<string, typeof flags>();
  for (const f of flags) if (f.holderUserId) byHolder.set(f.holderUserId, [...(byHolder.get(f.holderUserId) ?? []), f]);
  for (const [holderId, hf] of byHolder) {
    const holder = users.get(holderId);
    if (holder?.email) void sendDfyOperatorSlaEmail({ to: holder.email, items: hf.map((f) => ({ engagementId: f.engagementId, reasons: f.reasons })) });
  }
  return NextResponse.json({ flagged: flags.length, checked: engagements.length });
}
