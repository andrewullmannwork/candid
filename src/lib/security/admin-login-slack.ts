/**
 * Security Slack notifier for admin-login lockouts (dedicated security channel).
 *
 * Mirrors id-block/slack.ts: a PURE message builder + a non-fatal chat.postMessage
 * POST with SLACK_BOT_TOKEN. Fires ONCE per lockout transition (the failed attempt that
 * crosses the threshold), called from the admin-password route via after() so it never
 * adds latency to the response.
 *
 * Channel: dedicated security channel C0BEX5FQHJP (Andrew). Override via
 * SLACK_SECURITY_CHANNEL_ID.
 *
 * Failure modes (non-fatal — never throws): SLACK_BOT_TOKEN unset → skip + warn;
 * Slack API error → log + swallow. The lockout is already enforced in the DB upstream.
 */

const SLACK_API_BASE = "https://slack.com/api";
const DEFAULT_SECURITY_CHANNEL_ID = "C0BEX5FQHJP";

export function resolveSecurityChannelId(): string {
  return process.env.SLACK_SECURITY_CHANNEL_ID ?? DEFAULT_SECURITY_CHANNEL_ID;
}

export interface AdminLockoutPayload {
  /** The route that locked out, e.g. "/api/auth/admin-password". */
  route: string;
  /** VERCEL_ENV / NODE_ENV — "production" | "preview" | "development" | "unknown". */
  environment: string;
  /** The client IP whose bucket locked (the frozen address). */
  clientIp: string;
  /** Configured consecutive-failure threshold that triggered the lock. */
  lockoutThreshold: number;
  /** When the lockout expires (auto-unfreeze). */
  lockedUntil: Date;
  /** Lockout duration in seconds. */
  lockoutSeconds: number;
  /** When the lockout was triggered. */
  occurredAt: Date;
}

/** Self-contained message body — everything needed to judge the event without leaving Slack. */
export function buildAdminLockoutSlackText(p: AdminLockoutPayload): string {
  const mins = Math.round(p.lockoutSeconds / 60);
  return [
    ":lock: *Admin login lockout triggered*",
    "",
    "A single IP hit the admin-password failure threshold and is now temporarily frozen.",
    "",
    `*Route:* \`${p.route}\``,
    `*Environment:* ${p.environment}`,
    `*Client IP:* \`${p.clientIp}\``,
    `*Trigger:* reached the lockout threshold — ${p.lockoutThreshold} consecutive failed admin-password attempts`,
    `*Locked until:* ${p.lockedUntil.toISOString()}  (~${mins} min)`,
    `*Occurred at:* ${p.occurredAt.toISOString()}`,
    "",
    `*What this means:* repeated wrong admin-password guesses came from this IP. That address is frozen for ~${mins} min — per-IP, and it auto-expires (no permanent lock; a legitimate admin just waits it out).`,
    "*If this wasn't expected:* rotate `ADMIN_PASSWORD`, confirm `admin_login_hardening_v1.turnstile_required` is on, and watch this channel for lockouts from *other* IPs (a sign of a distributed attempt).",
  ].join("\n");
}

/**
 * Fire the lockout alert. Non-fatal: never throws. `fetchImpl` is injectable for tests.
 */
export async function notifyAdminLockout(
  payload: AdminLockoutPayload,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    console.warn(
      `[admin-login-slack] SLACK_BOT_TOKEN not set; lockout alert skipped (ip=${payload.clientIp})`,
    );
    return;
  }
  const fetchFn = fetchImpl ?? fetch;
  try {
    const res = await fetchFn(`${SLACK_API_BASE}/chat.postMessage`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: resolveSecurityChannelId(),
        text: buildAdminLockoutSlackText(payload),
        mrkdwn: true,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !data.ok) {
      console.warn(
        `[admin-login-slack] chat.postMessage failed: http=${res.status} slack_error=${data.error ?? "unknown"} (ip=${payload.clientIp})`,
      );
    }
  } catch (err) {
    console.warn(
      `[admin-login-slack] post threw (non-fatal): ${err instanceof Error ? err.message : String(err)} (ip=${payload.clientIp})`,
    );
  }
}
