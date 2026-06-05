/**
 * Ing-E G7 — Slack alert for the daily PII-audit cron.
 *
 * Mirrors bill-parser-slack.ts: chat.postMessage via SLACK_BOT_TOKEN to a DEDICATED
 * channel (SLACK_PII_ALERTS_CHANNEL_ID env override; default below). A PII/compliance
 * signal must be unmissable + cleanly auditable, so it does NOT share the cost/parser
 * ops channels. Non-fatal: never throws — a Slack failure must not fail the cron (the
 * run is already recorded in pii_audit_runs). Aggregate text only (no raw excerpt).
 */
const SLACK_API_BASE = "https://slack.com/api";
// Dedicated PII-alerts channel (created S167).
const DEFAULT_PII_ALERTS_CHANNEL_ID = "C0B8D6JLY2J";

export function resolvePiiAlertChannelId(): string {
  return process.env.SLACK_PII_ALERTS_CHANNEL_ID ?? DEFAULT_PII_ALERTS_CHANNEL_ID;
}

export function buildPiiAlertText(status: string, summary: string): string {
  const emoji = status === "alert" ? ":rotating_light:" : status === "error" ? ":warning:" : ":mag:";
  const title =
    status === "alert"
      ? "PII detected in a cross-user surface"
      : status === "error"
        ? "PII-audit sweep error"
        : "PII-audit liveness gap";
  return [
    `${emoji} *Ing-E PII audit — ${title}*`,
    ``,
    summary,
    ``,
    `→ aggregate only; investigate via the pii_audit_runs ledger (service-role).`,
  ].join("\n");
}

/**
 * Post a PII-audit alert. Returns {ok} so the wiring smoke can confirm bot-in-channel
 * (Slack `not_in_channel` is the classic miss). Never throws.
 */
export async function postPiiAlert(
  status: string,
  summary: string,
  fetchImpl?: typeof fetch,
): Promise<{ ok: boolean; error?: string }> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    console.warn("[pii-alert-slack] SLACK_BOT_TOKEN not set; alert skipped");
    return { ok: false, error: "no_bot_token" };
  }
  const fetchFn = fetchImpl ?? fetch;
  try {
    const res = await fetchFn(`${SLACK_API_BASE}/chat.postMessage`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: resolvePiiAlertChannelId(), text: buildPiiAlertText(status, summary), mrkdwn: true }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !data.ok) {
      console.warn(`[pii-alert-slack] postMessage failed: http=${res.status} slack_error=${data.error ?? "unknown"}`);
      return { ok: false, error: data.error ?? `http_${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.warn(`[pii-alert-slack] post threw (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, error: "threw" };
  }
}
