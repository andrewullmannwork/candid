/**
 * ID-Block — Slack notifier for corroboration would-flags (Fraud/Spam channel).
 *
 * Mirrors bill-parser-slack.ts / truncation-telemetry.ts: a PURE message builder +
 * a non-fatal chat.postMessage POST with SLACK_BOT_TOKEN. Fires on each gate
 * would-flag (shadow OR active), deduped per cluster by the caller (one Slack per
 * live quarantine row, not per retry).
 *
 * Channel: Fraud/Spam C0B8MQL9CQ6 (NOT the backend-ops / bill-parser channels).
 * Override via SLACK_ID_BLOCK_CHANNEL_ID.
 *
 * Failure modes (non-fatal — never throws): SLACK_BOT_TOKEN unset → skip + warn;
 * Slack API error → log + swallow (the quarantine row is already written upstream).
 *
 * SoT: plans/id-block-corroboration-source-independence.md §5.
 */

const SLACK_API_BASE = "https://slack.com/api";
// Fraud/Spam channel (Andrew, S171) — dedicated; not shared with Cost-F / bill-parser.
const DEFAULT_SLACK_CHANNEL_ID = "C0B8MQL9CQ6";
const DEFAULT_ADMIN_URL_BASE = "https://www.candidclaim.com";

function resolveAdminUrlBase(): string {
  return process.env.APP_BASE_URL ?? DEFAULT_ADMIN_URL_BASE;
}

export function resolveSlackChannelId(): string {
  return process.env.SLACK_ID_BLOCK_CHANNEL_ID ?? DEFAULT_SLACK_CHANNEL_ID;
}

export interface IdBlockNotifyPayload {
  quarantineId: string | null;
  canonicalPlanId: string;
  documentType: string;
  mode: "shadow" | "active";
  /** "held" (active withhold) | "shadow" (logged, not held). */
  state: "shadow" | "held";
  clusterScore: number;
  clusterSize: number;
  sameContent: boolean;
  novelCanonical: boolean;
  scaleTier: string;
  reasons: string[];
}

export function buildAdminDeepLink(canonicalPlanId: string): string {
  // PR3a landed the dedicated work-list; deep-link the canonical's cluster card there.
  return `${resolveAdminUrlBase()}/admin/promotion-quarantine#canonical-${canonicalPlanId}`;
}

export function buildSlackMessageText(payload: IdBlockNotifyPayload): string {
  const emoji = payload.state === "held" ? ":no_entry:" : ":mag:";
  const title =
    payload.state === "held"
      ? "ID-Block — promotion HELD (corroboration source-independence)"
      : "ID-Block — would-flag (shadow)";
  const triggers = [
    payload.sameContent ? "same-content replay" : null,
    payload.novelCanonical ? "novel canonical" : null,
  ]
    .filter(Boolean)
    .join(" + ");

  const lines: string[] = [
    `${emoji} *${title}*`,
    ``,
    `canonical_plan_id: \`${payload.canonicalPlanId}\``,
    `document_type: \`${payload.documentType}\``,
    `mode: \`${payload.mode}\`  |  state: \`${payload.state}\`  |  scale: \`${payload.scaleTier}\``,
    `triggers: ${triggers || "—"}`,
    `cluster_score: ${payload.clusterScore.toFixed(3)}  |  cluster_size: ${payload.clusterSize}`,
  ];
  if (payload.quarantineId) lines.push(`quarantine_id: \`${payload.quarantineId}\``);
  if (payload.reasons.length > 0) lines.push(`reasons: ${payload.reasons.join("; ")}`);
  lines.push(``);
  lines.push(`→ Review at ${buildAdminDeepLink(payload.canonicalPlanId)}`);
  return lines.join("\n");
}

/**
 * Fire a Slack chat.postMessage for an ID-Block would-flag. Non-fatal: never throws.
 * Caller should `void` the promise.
 */
export async function notifyIdBlockCluster(
  payload: IdBlockNotifyPayload,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    console.warn(
      `[id-block-slack] SLACK_BOT_TOKEN not set; notification skipped (canonical=${payload.canonicalPlanId} state=${payload.state})`,
    );
    return;
  }

  const channelId = resolveSlackChannelId();
  const text = buildSlackMessageText(payload);
  const fetchFn = fetchImpl ?? fetch;

  try {
    const res = await fetchFn(`${SLACK_API_BASE}/chat.postMessage`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: channelId, text, mrkdwn: true }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !data.ok) {
      console.warn(
        `[id-block-slack] chat.postMessage failed: http=${res.status} slack_error=${data.error ?? "unknown"} (canonical=${payload.canonicalPlanId})`,
      );
    }
  } catch (err) {
    console.warn(
      `[id-block-slack] post threw (non-fatal): ${err instanceof Error ? err.message : String(err)} (canonical=${payload.canonicalPlanId})`,
    );
  }
}
