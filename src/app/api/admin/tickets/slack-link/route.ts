/**
 * GET /api/admin/tickets/slack-link?ticketId=<uuid>
 *
 * Resolves a support ticket's stored slack_thread_ts to a Slack permalink so the
 * admin can jump straight into the ticket's #support thread — where replying
 * emails the user via Resend (see /api/slack/events + src/lib/email/support-reply).
 * Keeping the whole reply loop in Slack is deliberate: no second reply UI to build.
 *
 * Auth: requireAdmin. support_tickets is a user-owned table, so the read goes
 * through adminScoped (cross-user admin authority), not a raw `.from()`.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/require-admin";
import { adminScoped } from "@/lib/security/user-scoped";

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const ticketId = req.nextUrl.searchParams.get("ticketId");
  if (!ticketId) {
    return NextResponse.json({ error: "ticketId required" }, { status: 400 });
  }

  const admin = await adminScoped(auth.supabase, auth.adminUserId);
  const { data: ticket } = await admin
    .table("support_tickets")
    .select("slack_thread_ts")
    .eq("id", ticketId)
    .maybeSingle();

  const ts = (ticket?.slack_thread_ts as string | null) ?? null;
  if (!ts) {
    return NextResponse.json(
      { error: "This ticket has no linked Slack thread (created before Slack was wired, or the Slack post failed)." },
      { status: 404 },
    );
  }

  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_SUPPORT_CHANNEL_ID;
  if (!token || !channel) {
    return NextResponse.json({ error: "Slack is not configured on the server." }, { status: 503 });
  }

  try {
    const res = await fetch(
      `https://slack.com/api/chat.getPermalink?channel=${encodeURIComponent(channel)}&message_ts=${encodeURIComponent(ts)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = (await res.json()) as { ok: boolean; permalink?: string; error?: string };
    if (!data.ok || !data.permalink) {
      return NextResponse.json(
        { error: `Slack permalink lookup failed: ${data.error ?? "unknown"}` },
        { status: 502 },
      );
    }
    return NextResponse.json({ permalink: data.permalink });
  } catch (err) {
    console.error("[admin/tickets/slack-link] getPermalink failed:", err);
    return NextResponse.json({ error: "Slack request failed." }, { status: 502 });
  }
}
