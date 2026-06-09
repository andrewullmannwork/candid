/**
 * ID-Block — Slack notifier for the corroboration subsystem (dedicated ID-Block channel).
 *
 * Mirrors bill-parser-slack.ts / truncation-telemetry.ts: a PURE message builder +
 * a non-fatal chat.postMessage POST with SLACK_BOT_TOKEN. Two events, one channel:
 *   - would-flag  (notifyIdBlockCluster) — the live gate flagged a promotion (shadow OR
 *     active), deduped per cluster by the caller (one Slack per live quarantine row).
 *   - release     (notifyIdBlockRelease) — the PR3c daily re-eval cron auto-promoted a
 *     held promotion because its cluster legitimacy cleared (delayed-not-denied). Fires
 *     once per release (held→promoted is a one-time, state-guarded transition).
 *
 * Channel: the dedicated ID-Block channel C0B99G7K0MA (Andrew, S176 — consolidated; the
 * subsystem no longer shares the general Fraud/Spam channel). Override via
 * SLACK_ID_BLOCK_CHANNEL_ID.
 *
 * Failure modes (non-fatal — never throws): SLACK_BOT_TOKEN unset → skip + warn;
 * Slack API error → log + swallow (the quarantine row is already written upstream).
 *
 * SoT: plans/id-block-corroboration-source-independence.md §5 + §3.5.
 */

const SLACK_API_BASE = "https://slack.com/api";
// Dedicated ID-Block channel (Andrew, S176) — all corroboration events (would-flag +
// release) land here; not shared with Cost-F / bill-parser / general Fraud-Spam.
const DEFAULT_SLACK_CHANNEL_ID = "C0B99G7K0MA";
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

export function buildAdminDeepLink(
  canonicalPlanId: string,
  scope: "live" | "all" = "live",
): string {
  // PR3a landed the dedicated work-list; deep-link the canonical's cluster card there.
  // Releases (promoted rows) only render under ?scope=all (the default Live view is
  // shadow+held) — the page reads ?scope from the URL + scrolls to the anchor (PR3c).
  const q = scope === "all" ? "?scope=all" : "";
  return `${resolveAdminUrlBase()}/admin/promotion-quarantine${q}#canonical-${canonicalPlanId}`;
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
 * Shared non-fatal chat.postMessage to the ID-Block channel. Never throws; missing
 * SLACK_BOT_TOKEN or an API error is logged + swallowed (the quarantine row / promotion
 * is already persisted upstream). `ctxLabel` rides the warn lines for triage.
 */
async function postIdBlockSlack(
  text: string,
  ctxLabel: string,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    console.warn(`[id-block-slack] SLACK_BOT_TOKEN not set; notification skipped (${ctxLabel})`);
    return;
  }
  const channelId = resolveSlackChannelId();
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
        `[id-block-slack] chat.postMessage failed: http=${res.status} slack_error=${data.error ?? "unknown"} (${ctxLabel})`,
      );
    }
  } catch (err) {
    console.warn(
      `[id-block-slack] post threw (non-fatal): ${err instanceof Error ? err.message : String(err)} (${ctxLabel})`,
    );
  }
}

/**
 * Fire a Slack chat.postMessage for an ID-Block would-flag. Non-fatal: never throws.
 * Caller should `void` the promise.
 */
export async function notifyIdBlockCluster(
  payload: IdBlockNotifyPayload,
  fetchImpl?: typeof fetch,
): Promise<void> {
  await postIdBlockSlack(
    buildSlackMessageText(payload),
    `canonical=${payload.canonicalPlanId} state=${payload.state}`,
    fetchImpl,
  );
}

// ── PR3c — re-eval cron auto-release notification ─────────────────────────────

export interface IdBlockReleasePayload {
  quarantineId: string;
  canonicalPlanId: string;
  documentType: string;
  /** the median cluster legitimacy at release time (now ≥ the bar). */
  clusterScore: number;
  clusterSize: number;
  scaleTier: string;
  /** machine reason for the release — e.g. 're_eval_cleared'. */
  reason: string;
  /** observed Layer-3 criteria the real promote writer re-derived (for context). */
  observed?: { distinctUsers: number; totalUploads: number; coverageScore: number };
}

export function buildReleaseMessageText(payload: IdBlockReleasePayload): string {
  const lines: string[] = [
    `:white_check_mark: *ID-Block — promotion AUTO-RELEASED (re-eval cleared)*`,
    ``,
    `A held promotion's cluster legitimacy crossed the bar; the daily re-eval cron re-ran the gate and released it (delayed-not-denied). No admin action was required.`,
    ``,
    `canonical_plan_id: \`${payload.canonicalPlanId}\``,
    `document_type: \`${payload.documentType}\`  |  scale: \`${payload.scaleTier}\`  |  reason: \`${payload.reason}\``,
    `cluster_score: ${payload.clusterScore.toFixed(3)}  |  cluster_size: ${payload.clusterSize}`,
  ];
  if (payload.observed) {
    lines.push(
      `observed: distinct_users ${payload.observed.distinctUsers} · uploads ${payload.observed.totalUploads} · coverage ${payload.observed.coverageScore.toFixed(3)}`,
    );
  }
  lines.push(`quarantine_id: \`${payload.quarantineId}\``);
  lines.push(``);
  lines.push(`→ View at ${buildAdminDeepLink(payload.canonicalPlanId, "all")}`);
  return lines.join("\n");
}

/**
 * Fire a Slack chat.postMessage for an ID-Block re-eval auto-release. Non-fatal: never
 * throws. Once per release (held→promoted is a one-time, state-guarded transition).
 */
export async function notifyIdBlockRelease(
  payload: IdBlockReleasePayload,
  fetchImpl?: typeof fetch,
): Promise<void> {
  await postIdBlockSlack(
    buildReleaseMessageText(payload),
    `release canonical=${payload.canonicalPlanId}`,
    fetchImpl,
  );
}
