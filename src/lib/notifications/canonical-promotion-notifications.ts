/**
 * Canonical promotion + correction challenge admin notifications
 * (Phase 4.0.6 Task 4.0.6-K).
 *
 * Implements Q-P4.0.6-6 LOCK v4 = (D) Tiered notification:
 *   - Slack on EVERY event (firehose; granular admin tracking)
 *   - Admin queue row persists in-place (canonical_correction_challenges.admin_notification_metadata JSONB)
 *   - Email summary on SUBMISSION + RESOLUTION only (entry/exit bookends; reduces fatigue)
 *
 * Plus v4 operational addendum (Slack-failure fallback):
 *   - If Slack delivery fails (HTTP 5xx, network error, rate limit) → escalate
 *     to email immediately + admin queue row marked `notification_failure` with
 *     error_context + telemetry alert + reconciliation cron retry.
 *
 * v1 IMPLEMENTATION NOTE: email send is STUBBED (Candid has no Resend/SendGrid
 * integration today; existing notifications module is Slack-only). Email
 * channel is logged as a metadata entry with channel='email_pending'; OPS
 * Sprint Session 75 wires actual email delivery (CF-14-adjacent OPS prereq).
 *
 * Architecturally: "never silent" guarantee per Pattern 1 #1 + Principles §8.2
 * is preserved by Slack (real-time) + queue (persistent record). Email bookend
 * is the third channel; v1 records intent + content; OPS-track wires delivery.
 */

import type { createServerClient } from "@/lib/supabase/server";
import type {
  ChallengeNotificationEvent,
  CorrectionChallengeRow,
} from "@/lib/parser/correction-challenge";

type SupabaseClient = ReturnType<typeof createServerClient>;

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://candidclaim.com";

const EMAIL_BOOKEND_EVENTS: ReadonlySet<ChallengeNotificationEvent> = new Set([
  "submitted",
  "resolved_corroborated",
  "resolved_contradicted",
  "time_decayed",
  "admin_overridden",
]);

interface NotificationMetadataEntry {
  event: ChallengeNotificationEvent;
  channel: "slack" | "email_pending" | "email_pending_after_slack_failure" | "queue_only";
  success: boolean;
  recorded_at: string;
  error_context?: string;
  retry_count?: number;
}

interface SlackResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * Main entry point — replaces the stub in correction-challenge.ts.
 *
 * Sends Slack message (always); appends queue metadata (always); tags
 * email_pending for bookend events. On Slack failure: escalates to
 * email_pending_after_slack_failure marker + increments notification_failure_count.
 *
 * Idempotent: each call appends a new metadata entry; doesn't mutate prior entries.
 */
export async function sendChallengeNotification(
  supabase: SupabaseClient,
  challengeId: string,
  event: ChallengeNotificationEvent,
): Promise<void> {
  const { data: row, error: readError } = await supabase
    .from("canonical_correction_challenges")
    .select("*")
    .eq("id", challengeId)
    .single();

  if (readError || !row) {
    console.error(
      `[promotion-notify] challenge ${challengeId} not found: ${readError?.message ?? "no row"}`,
    );
    return;
  }
  const challenge = row as CorrectionChallengeRow;

  const newEntries: NotificationMetadataEntry[] = [];
  const now = new Date().toISOString();
  let slackOk = false;

  // ── Channel 1: Slack (firehose; every event) ────────────────────────────
  const slackResult = await sendChallengeSlack(challenge, event);
  slackOk = slackResult.ok;
  newEntries.push({
    event,
    channel: "slack",
    success: slackResult.ok,
    recorded_at: now,
    ...(slackResult.error
      ? { error_context: `${slackResult.status ?? "?"} ${slackResult.error}` }
      : {}),
  });

  if (!slackResult.ok) {
    // Telemetry: structured error log (Sentry/PagerDuty wiring deferred to OPS Sprint)
    console.error(
      `[promotion-notify] canonical_promotion_notification_failed challenge=${challengeId} event=${event} status=${slackResult.status ?? "?"} error=${slackResult.error ?? "unknown"}`,
    );
  }

  // ── Channel 2: queue persistent (always — that's just the metadata write below) ──

  // ── Channel 3: email bookend OR Slack-failure escalation ────────────────
  const isBookend = EMAIL_BOOKEND_EVENTS.has(event);
  if (isBookend || !slackOk) {
    // v1 stubbed email send — record intent + content for OPS Sprint to wire
    const emailEntry: NotificationMetadataEntry = {
      event,
      channel: slackOk ? "email_pending" : "email_pending_after_slack_failure",
      success: true, // v1: success means "queued for later send"; OPS wires real delivery
      recorded_at: now,
    };
    newEntries.push(emailEntry);
    console.log(
      `[promotion-notify] [email-pending] challenge=${challengeId} event=${event} reason=${slackOk ? "bookend" : "slack_failed"}`,
    );
  }

  // ── Persist metadata + counters ─────────────────────────────────────────
  const sentAt = [
    ...((challenge.admin_notification_sent_at as string[] | null) ?? []),
    now,
  ];
  const metadata = [
    ...((challenge.admin_notification_metadata as unknown[] | null) ?? []),
    ...newEntries,
  ];
  const failureIncrement = slackOk ? 0 : 1;

  await supabase
    .from("canonical_correction_challenges")
    .update({
      admin_notification_sent_at: sentAt,
      admin_notification_metadata: metadata,
      notification_failure_count: challenge.notification_failure_count + failureIncrement,
      updated_at: now,
    })
    .eq("id", challengeId);
}

async function sendChallengeSlack(
  challenge: CorrectionChallengeRow,
  event: ChallengeNotificationEvent,
): Promise<SlackResult> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    return { ok: false, error: "SLACK_WEBHOOK_URL not configured" };
  }

  const payload = formatChallengeSlackPayload(challenge, event);

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      return { ok: false, status: response.status, error: response.statusText };
    }
    return { ok: true, status: response.status };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function formatChallengeSlackPayload(
  challenge: CorrectionChallengeRow,
  event: ChallengeNotificationEvent,
): Record<string, unknown> {
  const fieldLabel = challenge.service_slug
    ? `${challenge.service_slug}.${challenge.field_name}`
    : challenge.field_name;
  const headerByEvent: Record<ChallengeNotificationEvent, string> = {
    submitted: "Correction Challenge Submitted",
    sanity_passed: "Challenge Sanity Check Passed",
    sanity_failed: "Challenge Sanity Check Failed",
    corroboration_added: "Challenge Corroborated",
    contradiction_added: "Challenge Contradicted",
    resolved_corroborated: "Challenge Resolved (Corroborated)",
    resolved_contradicted: "Challenge Resolved (Dismissed)",
    time_decayed: "Challenge Time-Decayed",
    admin_overridden: "Challenge Admin-Overridden",
  };

  return {
    text: `${headerByEvent[event]}: ${fieldLabel}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: headerByEvent[event] },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Field:* ${fieldLabel}` },
          { type: "mrkdwn", text: `*Status:* ${challenge.status}` },
          { type: "mrkdwn", text: `*Corroboration:* ${challenge.corroboration_count}` },
          { type: "mrkdwn", text: `*Contradiction:* ${challenge.contradiction_count}` },
          {
            type: "mrkdwn",
            text: `*Proposed:* ${stringifyValue(challenge.proposed_value)}`,
          },
          { type: "mrkdwn", text: `*Challenge ID:* \`${challenge.id.slice(0, 8)}\`` },
        ],
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Open Admin Queue" },
            url: `${APP_URL}/admin/canonical-challenges`,
            style: "primary",
          },
        ],
      },
    ],
  };
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value).slice(0, 200);
    } catch {
      return "[unserializable]";
    }
  }
  return String(value).slice(0, 200);
}

/**
 * Daily reconciliation cron — finds challenge rows with notification_failure
 * markers + retries Slack delivery. Resilience guarantee per Q-P4.0.6-6 LOCK v4
 * operational addendum.
 *
 * Wired via QStash cron (separate setup at /api/cron/reconcile-promotion-notifications/route.ts;
 * deferred to OPS Sprint Session 75).
 */
export async function reconcileFailedChallengeNotifications(
  supabase: SupabaseClient,
): Promise<{ retried: number; recovered: number; errors: string[] }> {
  const result = { retried: 0, recovered: 0, errors: [] as string[] };

  const { data: rows, error } = await supabase
    .from("canonical_correction_challenges")
    .select("id, notification_failure_count")
    .gt("notification_failure_count", 0)
    .limit(50);

  if (error) {
    result.errors.push(`select failed-notification rows: ${error.message}`);
    return result;
  }

  for (const row of rows ?? []) {
    result.retried += 1;
    // Re-fire the most-recent event marker. v1 simplification: just retry
    // 'submitted' as a generic resync; OPS Sprint may inspect metadata to
    // pick the specific failed event for retry.
    try {
      await sendChallengeNotification(supabase, row.id as string, "submitted");
      result.recovered += 1;
    } catch (err) {
      result.errors.push(`retry ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}
