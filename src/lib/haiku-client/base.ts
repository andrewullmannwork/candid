/**
 * Shared Claude Haiku 4.5 call infrastructure for text-extraction parsers.
 *
 * Used by every text-based Haiku integration on Candid (EOC, SBC, plan_doc, future
 * formulary). Locked at Phase 3.1A.1 close; extracted to shared library at Phase 3.2
 * (Task A) per Pattern P-6 hard rule ("New Haiku integrations MUST reference
 * dr3d_dogfood_findings as authority on caching threshold, adaptive max_tokens,
 * defensive post-process, empirical dogfood methodology"). Single source of truth
 * eliminates drift risk across parsers during ongoing soak iterations.
 *
 * Implements the 7 universal mechanisms from Phase 3.1A.1:
 *   - (1) cache_control: ephemeral on the static prompt block. LIVE for EOC + plan-doc since
 *     S187: Claude Haiku 4.5 requires a 4096-real-token minimum cacheable prefix, and those
 *     parsers' prompts are lifted over it by the inert cache_pad_v1 prefix
 *     (src/lib/haiku-client/cache-pad.ts — sizing/regen path documented there; S187 probe:
 *     ecm-14 full parse 23.2→3.7 min, cache reads ~600K tok/parse). Cost-H.2 (S198)
 *     MEASURED the rest: the bill INSTRUCTIONS is 8,849 tok (raw_json) / 13,018 (tool_use,
 *     +tool schema) — already OVER the floor, so the bill's existing cache_control ALREADY
 *     caches; its zero cost-event cache columns were a WIRING gap (no recordCostEvent call),
 *     closed S198. SBC-legacy/card/classifier are single-shot / non-cacheable (no separable
 *     prefix) → no padding warranted anywhere beyond the S187 EOC + plan-doc set.
 *     DECISION RECORD (S187): inert-static padding chosen over the earlier "value-adding
 *     content (slug list, few-shot)" idea — value-adding content changes extraction behavior
 *     and would stale the T5 universal eval; the swap remains PARKED post-T5 (see cache-pad.ts).
 *     Realistic saving is ~35-50% of static-prompt input spend per cold parse (~3x warm), NOT
 *     the older ~10x estimate — output tokens + chunk text dominate; the latency win is the
 *     headline. Source: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 *   - (2) Adaptive max_tokens (input + 4000, capped at HAIKU_MAX_OUTPUT)
 *   - (3) Truncation retry at HAIKU_MAX_OUTPUT
 *   - (4) Stochastic JSON parse retry-once (Phase 3.1B reliability fix)
 *   - jsonrepair fallback + regex JSON extraction inside parseHaikuJSON
 *
 * S73 (Session 76) — Iteration-cost tooling: env-var-gated snapshot replay layer
 * sits in front of the Anthropic API call. When `HAIKU_SNAPSHOT_REPLAY=true`, calls
 * check a disk cache at `.haiku_snapshots/<key>.json` first; cache hits return saved
 * responses with zero API cost. Misses fall through to the real API and write a new
 * snapshot for future runs. Records always happen on cache miss in replay mode;
 * standalone recording (no replay) via `HAIKU_SNAPSHOT_RECORD=true`. Cache key =
 * sha256 of (systemPrompt + userContent + sectionLabel). Used for verifier-only
 * iteration cycles + diagnostic re-runs without burning Haiku spend.
 *
 * Cost telemetry: per-call input/output tokens + USD computed via Haiku 4.5 published rates.
 * Mechanisms (5) granular dispatch, (6) cost-cap pre-dispatch guard, (7) Pattern P-8
 * two-pass verifier all live elsewhere — they are parser-orchestrator + verifier
 * concerns, not Haiku-call concerns.
 */

import Anthropic from "@anthropic-ai/sdk";
import { jsonrepair } from "jsonrepair";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

export const HAIKU_MODEL = "claude-haiku-4-5-20251001";
export const HAIKU_MAX_OUTPUT = 32000;

// Haiku 4.5 published rates (per 1M tokens). Corrected S198 (Cost-H.2) — were
// 0.80/4.00/0.08, which understated cost ~20% across ALL parser cost telemetry.
// Source: Anthropic Haiku 4.5 pricing ($1 input / $5 output per MTok; cache read
// = 10% of input; cache write = +25%, applied inline in haikuUsageCostUsd).
const HAIKU_INPUT_USD_PER_1M = 1.00;
const HAIKU_OUTPUT_USD_PER_1M = 5.00;
const HAIKU_CACHED_INPUT_USD_PER_1M = 0.10; // cache read = 10% of input

/**
 * Haiku usage → USD, split by cache class: uncached input at full rate, cache
 * *writes* at a 25% premium (5-min ephemeral), cache *reads* at the cached rate,
 * output at the output rate. Shared so every Haiku caller — the wrapped client
 * here AND direct `messages.create` callers (e.g. the bill parser, S198) — prices
 * a parse identically. Tolerates partial usage objects (missing fields → 0).
 */
export function haikuUsageCostUsd(usage: {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
} | null | undefined): number {
  const u = usage ?? {};
  return (
    ((u.input_tokens ?? 0) * HAIKU_INPUT_USD_PER_1M) / 1_000_000 +
    ((u.cache_creation_input_tokens ?? 0) * HAIKU_INPUT_USD_PER_1M * 1.25) / 1_000_000 +
    ((u.cache_read_input_tokens ?? 0) * HAIKU_CACHED_INPUT_USD_PER_1M) / 1_000_000 +
    ((u.output_tokens ?? 0) * HAIKU_OUTPUT_USD_PER_1M) / 1_000_000
  );
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function adaptiveMaxTokens(inputTokens: number): number {
  return Math.min(inputTokens + 4000, HAIKU_MAX_OUTPUT);
}

export function getClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[haiku-client] ANTHROPIC_API_KEY not set");
    return null;
  }
  // 180s timeout: EOC + SBC parsers may emit large per-section JSON outputs (e.g.,
  // 30+ services × 22 fields = ~660 entries) that exceed Haiku's response generation
  // time. 60s was too tight; observed timeouts on Blue Shield SBC common_medical_events
  // section. Matches legacy claude-extractor.ts:23 config (timeout: 120000) — bumped
  // higher to give comfortable headroom for the longest sections.
  return new Anthropic({ apiKey, timeout: 180000, maxRetries: 3 });
}

export function parseHaikuJSON(text: string): unknown {
  const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

  // Helper: when a parser returns an array (e.g., jsonrepair "fixing" `{...}\n###notes`
  // by wrapping into `[{...}, "###notes"]`), unwrap to the first object element if
  // that's the shape we recognize. All Candid Haiku parsers expect a top-level
  // JSON OBJECT (RawResponse, { services: [...] }, etc.); never a top-level array.
  // Session 77: defense against over-prompted-model commentary appended after the
  // intended JSON — prompt explicitly forbids commentary, this layer recovers if
  // a stray run still emits some.
  const unwrapArrayIfNeeded = (val: unknown): unknown => {
    if (
      Array.isArray(val) &&
      val.length > 0 &&
      typeof val[0] === "object" &&
      val[0] !== null &&
      !Array.isArray(val[0])
    ) {
      return val[0];
    }
    return val;
  };

  try {
    return unwrapArrayIfNeeded(JSON.parse(cleaned));
  } catch {
    try {
      return unwrapArrayIfNeeded(JSON.parse(jsonrepair(cleaned)));
    } catch (err) {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return unwrapArrayIfNeeded(JSON.parse(jsonrepair(match[0])));
        } catch {
          throw err;
        }
      }
      throw err;
    }
  }
}

export interface HaikuCallResult<T> {
  data: T;
  /** ALL input tokens (uncached + cache-write + cache-read) — historical field semantics preserved. */
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  warnings: string[];
  /**
   * S187 cache-class breakout (optional on this SHARED type so all callers/old snapshots stay
   * valid; the EOC/plan-doc section types require them so the compiler forces threading).
   * Both 0 until a prompt's static prefix crosses the model's minimum cacheable length —
   * cache_pad_v1 (cache-pad.ts) lifts the EOC + plan-doc prompts over it.
   */
  cacheCreateTokens?: number;
  cacheReadTokens?: number;
}

// ── Snapshot replay layer (S73 Session 76 iteration-cost tooling) ──────────
//
// Disk-backed response cache keyed by (systemPrompt, userContent, sectionLabel).
// Two env-var modes:
//
//   HAIKU_SNAPSHOT_REPLAY=true   → cache-first: hits return saved response with $0
//                                  API cost; misses fall through to API + record
//                                  for future runs (incremental population).
//   HAIKU_SNAPSHOT_RECORD=true   → always call API + write snapshots. Use this
//                                  to seed snapshots from one expensive run before
//                                  iterating with REPLAY=true.
//
// Cache directory: `.haiku_snapshots/` under repo root (gitignored). Override via
// HAIKU_SNAPSHOT_DIR env var (e.g., `.haiku_snapshots/s73_baseline/`) to keep
// multiple snapshot sets isolated between iteration cycles.
//
// Key: sha256(systemPrompt + " " + userContent + " " + sectionLabel),
// 16-char hex prefix. NUL separator avoids collision via concatenation ambiguity.
// Snapshot files include `_label` field for human-readability + dispatch context.

const SNAPSHOT_DIR_DEFAULT = ".haiku_snapshots";
const SNAPSHOT_KEY_LENGTH = 16;

function getSnapshotDir(): string {
  return process.env.HAIKU_SNAPSHOT_DIR ?? SNAPSHOT_DIR_DEFAULT;
}

function isSnapshotReplayEnabled(): boolean {
  return process.env.HAIKU_SNAPSHOT_REPLAY === "true";
}

function isSnapshotRecordEnabled(): boolean {
  // Records also happen on cache miss when REPLAY=true (incremental population).
  return process.env.HAIKU_SNAPSHOT_RECORD === "true" || isSnapshotReplayEnabled();
}

function snapshotKey(systemPrompt: string, userContent: string, sectionLabel: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(systemPrompt);
  hash.update(" ");
  hash.update(userContent);
  hash.update(" ");
  hash.update(sectionLabel);
  return hash.digest("hex").slice(0, SNAPSHOT_KEY_LENGTH);
}

function snapshotPath(key: string): string {
  return path.join(getSnapshotDir(), `${key}.json`);
}

interface SnapshotEnvelope<T> extends HaikuCallResult<T> {
  _label?: string;
  _recordedAt?: string;
}

function readSnapshot<T>(key: string): SnapshotEnvelope<T> | null {
  const file = snapshotPath(key);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as SnapshotEnvelope<T>;
  } catch (err) {
    console.warn(`[haiku-client] snapshot read failed: ${file}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

function writeSnapshot<T>(key: string, result: HaikuCallResult<T>, sectionLabel: string): void {
  const dir = getSnapshotDir();
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const envelope: SnapshotEnvelope<T> = {
      ...result,
      _label: sectionLabel,
      _recordedAt: new Date().toISOString(),
    };
    fs.writeFileSync(snapshotPath(key), JSON.stringify(envelope, null, 2), "utf-8");
  } catch (err) {
    console.warn(`[haiku-client] snapshot write failed: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Call Haiku with cached system prompt + user content.
 * Implements truncation retry + stochastic JSON parse retry.
 *
 * Snapshot replay (S73): env-gated disk cache sits in front of the Anthropic API
 * call. When HAIKU_SNAPSHOT_REPLAY=true, returns saved responses for $0 cost on
 * cache hit; misses fall through to API + record. See section header for full docs.
 *
 * `sectionLabel` is used for log/warning prefixes AND as part of the snapshot
 * cache key; should be a short stable identifier like "eoc/prior_auth_codes" or
 * "sbc/important_questions".
 */
export async function callHaikuWithCache<T>(opts: {
  systemPrompt: string; // cached via cache_control: ephemeral
  userContent: string;
  sectionLabel: string;
  client?: Anthropic;
}): Promise<HaikuCallResult<T>> {
  // Snapshot replay short-circuit: cache hit returns immediately at $0 cost
  const key = snapshotKey(opts.systemPrompt, opts.userContent, opts.sectionLabel);
  if (isSnapshotReplayEnabled()) {
    const cached = readSnapshot<T>(key);
    if (cached) {
      return {
        data: cached.data,
        inputTokens: cached.inputTokens,
        outputTokens: cached.outputTokens,
        costUsd: 0, // replayed; no actual API spend
        warnings: [...cached.warnings, `haiku_snapshot_replay:${opts.sectionLabel}:${key}`],
      };
    }
    // Miss: fall through to real API call + record below (incremental population)
  }

  const client = opts.client ?? getClient();
  if (!client) {
    throw new Error(`[haiku-client/${opts.sectionLabel}] No Anthropic client (missing API key)`);
  }

  const inputTokens = estimateTokens(opts.systemPrompt + opts.userContent);
  const maxTokens = adaptiveMaxTokens(inputTokens);
  const warnings: string[] = [];

  const messages = [
    {
      role: "user" as const,
      content: [
        { type: "text" as const, text: opts.systemPrompt, cache_control: { type: "ephemeral" as const } },
        { type: "text" as const, text: "\n\n" + opts.userContent },
      ],
    },
  ];

  // Stream instead of a blocking create(): a long non-streaming generation holds the connection idle,
  // and a ~60s NAT/proxy idle-timeout drops it (confirmed S247 — non-stream dies at exactly 60s with
  // bytesRead:0, the same stream runs to 88s). .finalMessage() yields the identical Message (content +
  // stop_reason + usage); behavior-identical, it just keeps the socket active during generation.
  let response = await client.messages.stream({ model: HAIKU_MODEL, max_tokens: maxTokens, temperature: 0, messages }).finalMessage();

  // Truncation detection + retry at HAIKU_MAX_OUTPUT
  if (response.stop_reason === "max_tokens" && maxTokens < HAIKU_MAX_OUTPUT) {
    warnings.push(`haiku_truncation_retry:${opts.sectionLabel}`);
    response = await client.messages.stream({ model: HAIKU_MODEL, max_tokens: HAIKU_MAX_OUTPUT, temperature: 0, messages }).finalMessage();
    if (response.stop_reason === "max_tokens") {
      warnings.push(`haiku_truncation_at_max:${opts.sectionLabel}`);
    }
  }

  const text = response.content[0]?.type === "text" ? response.content[0].text : "";
  let data: T;
  try {
    data = parseHaikuJSON(text) as T;
  } catch {
    // Phase 3.1B reliability fix: stochastic JSON retry-once
    warnings.push(`haiku_json_retry:${opts.sectionLabel}`);
    response = await client.messages.stream({ model: HAIKU_MODEL, max_tokens: HAIKU_MAX_OUTPUT, temperature: 0, messages }).finalMessage();
    const retryText = response.content[0]?.type === "text" ? response.content[0].text : "";
    try {
      data = parseHaikuJSON(retryText) as T;
    } catch (retryErr) {
      throw new Error(`[haiku-client/${opts.sectionLabel}] JSON parse failed after retry: ${retryErr}`);
    }
  }

  // Compute cost. Anthropic SDK exposes usage incl cache_creation/cache_read tokens.
  const usage = response.usage as unknown as {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  const cacheCreate = usage?.cache_creation_input_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const uncachedInput = usage?.input_tokens ?? inputTokens;
  const outputTokens = usage?.output_tokens ?? estimateTokens(text);

  const costUsd = haikuUsageCostUsd({
    input_tokens: uncachedInput,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreate,
    cache_read_input_tokens: cacheRead,
  });

  const result: HaikuCallResult<T> = {
    data,
    inputTokens: uncachedInput + cacheCreate + cacheRead,
    outputTokens,
    costUsd,
    warnings,
    cacheCreateTokens: cacheCreate,
    cacheReadTokens: cacheRead,
  };

  // Persist to snapshot cache for future replay runs
  if (isSnapshotRecordEnabled()) {
    writeSnapshot(key, result, opts.sectionLabel);
  }

  return result;
}
