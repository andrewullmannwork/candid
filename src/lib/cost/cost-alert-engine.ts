/**
 * Cost-F alert engine (S129).
 *
 * Evaluates per-canonical cost thresholds + dispatches Slack alerts.
 * Called from /api/cron/cost-per-canonical-alerts (daily Vercel cron).
 *
 * Threshold rules (R9 refinement — relative + absolute, either fires):
 *   - relative_spike: per-day cost in last 7d > 2x rolling 30d median
 *   - absolute_threshold: 7d total cost > $5
 *
 * Dedup: 24h window per (canonical_id, alert_type) pair. Same canonical can
 * fire both relative AND absolute in same day (different alert_type rows).
 *
 * Slack: uses chat.postMessage API with SLACK_BOT_TOKEN env var (existing
 * Slack app bot token; same one used by support-notifications). Channel
 * hardcoded to COST_ALERTS_CHANNEL_ID. If SLACK_BOT_TOKEN is unset, alert
 * is logged to cost_alert_log with slack_delivery_status='skipped_no_webhook'
 * (legacy enum label; semantically "Slack delivery skipped due to missing
 * config") so operator action is auditable.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  aggregatePerCanonicalCost,
  wasRecentlyAlerted,
  type PerCanonicalCost,
} from "./cost-per-canonical";

const RELATIVE_SPIKE_MULTIPLIER = 2;
const ABSOLUTE_THRESHOLD_USD = 5;
const DEDUP_WINDOW_HOURS = 24;
const SLACK_API_BASE = "https://slack.com/api";
const COST_ALERTS_CHANNEL_ID = "C0B6XUUD3NU"; // Andrew-confirmed channel for cost alerts
const ADMIN_URL_BASE = "https://www.candidclaim.com";

export interface AlertEvaluationResult {
  canonicals_evaluated: number;
  alerts_fired: number;
  alerts_deduped: number;
  alerts_failed: number;
  alerts_skipped_no_webhook: number;
  details: Array<{
    canonical_plan_id: string;
    plan_name: string | null;
    alert_type: "relative_spike" | "absolute_threshold";
    outcome: "delivered" | "failed" | "skipped_no_webhook" | "deduped";
    cost_7d_usd: number;
    median_30d_usd: number | null;
  }>;
}

/**
 * Evaluate cost thresholds for all canonicals + fire Slack alerts on breach.
 * Returns a summary suitable for the cron handler to JSON-respond.
 */
export async function evaluateAndFireAlerts(
  supabase: SupabaseClient,
): Promise<AlertEvaluationResult> {
  // 7-day window for spike evaluation
  const candidates = await aggregatePerCanonicalCost(supabase, 7);

  const result: AlertEvaluationResult = {
    canonicals_evaluated: candidates.length,
    alerts_fired: 0,
    alerts_deduped: 0,
    alerts_failed: 0,
    alerts_skipped_no_webhook: 0,
    details: [],
  };

  const botToken = process.env.SLACK_BOT_TOKEN;

  for (const cand of candidates) {
    const breaches = evaluateBreaches(cand);
    for (const alertType of breaches) {
      const recentlyAlerted = await wasRecentlyAlerted(
        supabase,
        cand.canonical_plan_id,
        alertType,
        DEDUP_WINDOW_HOURS,
      );
      if (recentlyAlerted) {
        result.alerts_deduped += 1;
        result.details.push({
          canonical_plan_id: cand.canonical_plan_id,
          plan_name: cand.plan_name,
          alert_type: alertType,
          outcome: "deduped",
          cost_7d_usd: cand.cost_7d_usd,
          median_30d_usd: cand.baseline_30d_median_usd,
        });
        continue;
      }

      const slackOutcome = await fireSlackAlert(botToken, cand, alertType);

      // Always log the alert evaluation (even skipped_no_webhook) for audit
      await supabase.from("cost_alert_log").insert({
        canonical_plan_id: cand.canonical_plan_id,
        alert_type: alertType,
        cost_7d_usd: cand.cost_7d_usd,
        baseline_30d_median_usd: cand.baseline_30d_median_usd,
        slack_delivery_status: slackOutcome.status,
        slack_response_code: slackOutcome.responseCode,
      });

      if (slackOutcome.status === "delivered") result.alerts_fired += 1;
      else if (slackOutcome.status === "failed") result.alerts_failed += 1;
      else if (slackOutcome.status === "skipped_no_webhook") result.alerts_skipped_no_webhook += 1;

      result.details.push({
        canonical_plan_id: cand.canonical_plan_id,
        plan_name: cand.plan_name,
        alert_type: alertType,
        outcome: slackOutcome.status,
        cost_7d_usd: cand.cost_7d_usd,
        median_30d_usd: cand.baseline_30d_median_usd,
      });
    }
  }

  return result;
}

function evaluateBreaches(
  cand: PerCanonicalCost,
): Array<"relative_spike" | "absolute_threshold"> {
  const breaches: Array<"relative_spike" | "absolute_threshold"> = [];

  // Relative spike: per-day average in last 7d > 2x rolling 30d median
  if (
    cand.baseline_30d_median_usd !== null &&
    cand.baseline_30d_median_usd > 0 &&
    cand.spike_ratio !== null &&
    cand.spike_ratio >= RELATIVE_SPIKE_MULTIPLIER
  ) {
    breaches.push("relative_spike");
  }

  // Absolute threshold: 7d total cost > $5
  if (cand.cost_7d_usd > ABSOLUTE_THRESHOLD_USD) {
    breaches.push("absolute_threshold");
  }

  return breaches;
}

interface SlackFireOutcome {
  status: "delivered" | "failed" | "skipped_no_webhook";
  responseCode: number | null;
}

async function fireSlackAlert(
  botToken: string | undefined,
  cand: PerCanonicalCost,
  alertType: "relative_spike" | "absolute_threshold",
): Promise<SlackFireOutcome> {
  if (!botToken) {
    console.warn(
      `[cost-alert-engine] SLACK_BOT_TOKEN not set; alert recorded but not delivered (canonical=${cand.canonical_plan_id}, type=${alertType})`,
    );
    return { status: "skipped_no_webhook", responseCode: null };
  }

  const payload = buildSlackPayload(cand, alertType);

  try {
    const res = await fetch(`${SLACK_API_BASE}/chat.postMessage`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
    });
    // Slack returns 200 with { ok: false, error: "..." } on app-level errors
    // (e.g., channel_not_found, not_in_channel, invalid_auth). Check both
    // HTTP status AND payload.ok to classify delivery correctly.
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
    };
    if (res.ok && data.ok) {
      return { status: "delivered", responseCode: res.status };
    }
    console.warn(
      `[cost-alert-engine] Slack chat.postMessage failed: http=${res.status} slack_error=${
        data.error ?? "unknown"
      } (canonical=${cand.canonical_plan_id})`,
    );
    return { status: "failed", responseCode: res.status };
  } catch (err) {
    console.warn(
      `[cost-alert-engine] Slack chat.postMessage threw (canonical=${cand.canonical_plan_id}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { status: "failed", responseCode: null };
  }
}

function buildSlackPayload(
  cand: PerCanonicalCost,
  alertType: "relative_spike" | "absolute_threshold",
): Record<string, unknown> {
  const planLabel = cand.plan_name ?? "(unnamed plan)";
  const insurerLabel = cand.insurer_name ?? "(unknown insurer)";
  const adminUrl = `${ADMIN_URL_BASE}/admin/cost-per-canonical?canonical_id=${cand.canonical_plan_id}`;

  const headerText =
    alertType === "relative_spike"
      ? `Cost spike (${cand.spike_ratio?.toFixed(1) ?? "?"}x baseline)`
      : `Absolute cost threshold breached ($${cand.cost_7d_usd.toFixed(2)} > $${ABSOLUTE_THRESHOLD_USD})`;

  return {
    channel: COST_ALERTS_CHANNEL_ID,
    // Fallback text for notifications (when blocks aren't rendered)
    text: `Candid cost alert — ${headerText} for canonical ${planLabel} (${insurerLabel})`,
    unfurl_links: false,
    unfurl_media: false,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `🚨 Candid cost alert — ${headerText}` },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Canonical*\n${planLabel}` },
          { type: "mrkdwn", text: `*Insurer*\n${insurerLabel}` },
          { type: "mrkdwn", text: `*7d cost*\n$${cand.cost_7d_usd.toFixed(4)}` },
          {
            type: "mrkdwn",
            text: `*30d median (per-day)*\n${
              cand.baseline_30d_median_usd !== null
                ? `$${cand.baseline_30d_median_usd.toFixed(4)}`
                : "—"
            }`,
          },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Events in last 7d*: ${cand.event_count_7d}\n*Top parser kinds*: ${formatTopBreakdown(
            cand.parser_kind_breakdown,
          )}\n*Top sources*: ${formatTopBreakdown(cand.cost_source_breakdown)}`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "View in admin" },
            url: adminUrl,
          },
        ],
      },
    ],
  };
}

function formatTopBreakdown(breakdown: Record<string, number>, topN = 3): string {
  const entries = Object.entries(breakdown).sort((a, b) => b[1] - a[1]).slice(0, topN);
  if (entries.length === 0) return "—";
  return entries.map(([k, v]) => `${k}=$${v.toFixed(4)}`).join(", ");
}
