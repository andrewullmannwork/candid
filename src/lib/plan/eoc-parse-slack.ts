/**
 * EOC parse — terminal Slack notifier (S195 Phase B "tracking/messaging").
 *
 * Mirrors id-block/slack.ts: a PURE message builder + a non-fatal
 * chat.postMessage POST with SLACK_BOT_TOKEN. ONE event class: a parse
 * reaching a terminal state (processed | error), with the full per-unit
 * timing/cost table and the finish-phase breakdown — "what works and what
 * doesn't" lands in Slack on every EOC parse, success or failure, without DB
 * spelunking. The same data persists in `documents.metadata.eoc_parse_runlog`
 * (DB-first observability; Slack is the push layer).
 *
 * Channel: NO hardcoded default — resolved from `SLACK_EOC_PARSE_CHANNEL_ID`
 * env, else the `eoc_parser_v1.config.slack_channel_id` value the caller
 * passes (admin-settable via Studio, G6). Unresolvable channel → skip with a
 * log line, never throw (the runlog is already persisted upstream).
 */

const SLACK_API_BASE = "https://slack.com/api";

export function resolveEocSlackChannelId(configChannelId?: string | null): string | null {
  return process.env.SLACK_EOC_PARSE_CHANNEL_ID ?? (configChannelId || null);
}

export interface EocParseSlackPayload {
  outcome: "processed" | string; // non-"processed" = the failure reason string
  documentId: string;
  fileName: string;
  invocations: number;
  totalCostUsd: number;
  /** unit → { attempts, ms, cost_usd } from the runlog. */
  units: Record<string, { attempts: number; ms?: number; cost_usd?: number }>;
  /** finish-phase step → ms (assemble/persist breakdown); absent on failures
   * that never reached the finish path. */
  finishMs?: Record<string, number>;
  /** Whole-parse wall clock (state started_at → terminal), ms. */
  wallMs?: number;
}

function fmtMs(ms?: number): string {
  if (ms === undefined || ms === null) return "—";
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function buildEocParseSlackText(p: EocParseSlackPayload): string {
  const ok = p.outcome === "processed";
  const head = ok
    ? `:white_check_mark: *EOC parse completed* — \`${p.fileName}\``
    : `:rotating_light: *EOC parse FAILED* — \`${p.fileName}\``;
  const lines: string[] = [
    head,
    `doc \`${p.documentId}\` · invocations ${p.invocations} · spend $${p.totalCostUsd.toFixed(3)}${
      p.wallMs !== undefined ? ` · wall ${fmtMs(p.wallMs)}` : ""
    }`,
  ];
  if (!ok) lines.push(`reason: \`${p.outcome}\``);
  const unitLines = Object.entries(p.units).map(
    ([u, v]) =>
      `  • ${u}: ${fmtMs(v.ms)} · $${(v.cost_usd ?? 0).toFixed(3)}${
        (v.attempts ?? 1) > 1 ? ` · attempts=${v.attempts}` : ""
      }`,
  );
  if (unitLines.length > 0) lines.push("*units*", ...unitLines);
  if (p.finishMs && Object.keys(p.finishMs).length > 0) {
    lines.push(
      "*finish*",
      ...Object.entries(p.finishMs).map(([s, ms]) => `  • ${s}: ${fmtMs(ms)}`),
    );
  }
  return lines.join("\n");
}

/** Non-fatal terminal notification. Caller should `void` the promise. */
export async function notifyEocParseTerminal(
  payload: EocParseSlackPayload,
  configChannelId?: string | null,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const channelId = resolveEocSlackChannelId(configChannelId);
  if (!botToken || !channelId) {
    console.log(
      `[eoc-parse-slack] skipped (token=${botToken ? "set" : "unset"}, channel=${channelId ?? "unset"}) doc=${payload.documentId} outcome=${payload.outcome}`,
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
      body: JSON.stringify({ channel: channelId, text: buildEocParseSlackText(payload), mrkdwn: true }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !data.ok) {
      console.warn(
        `[eoc-parse-slack] chat.postMessage failed: http=${res.status} slack_error=${data.error ?? "unknown"} doc=${payload.documentId}`,
      );
    }
  } catch (err) {
    console.warn(
      `[eoc-parse-slack] post threw (non-fatal): ${err instanceof Error ? err.message : String(err)} doc=${payload.documentId}`,
    );
  }
}
