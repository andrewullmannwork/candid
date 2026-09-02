/**
 * postOpsMessage — ONE plain-text poster to the backend-ops Slack channel,
 * on the SAME bot token + chat.postMessage call the cost-alert engine and the
 * support notifier use. Fail-soft: no token → logged, never thrown.
 */
const SLACK_API_BASE = "https://slack.com/api";
const DEFAULT_OPS_CHANNEL = "C0B6XUUD3NU";

export async function postOpsMessage(text: string, opts: { channel?: string } = {}): Promise<boolean> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    console.warn("[ops-message] SLACK_BOT_TOKEN not set; message not delivered:", text.slice(0, 120));
    return false;
  }
  const channel = opts.channel ?? process.env.SLACK_BACKEND_OPS_CHANNEL_ID ?? DEFAULT_OPS_CHANNEL;
  try {
    const res = await fetch(`${SLACK_API_BASE}/chat.postMessage`, {
      method: "POST",
      headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel, text }),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !json.ok) {
      console.error(`[ops-message] chat.postMessage failed: http=${res.status} slack_error=${json.error ?? "?"}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[ops-message] chat.postMessage threw:", err);
    return false;
  }
}
