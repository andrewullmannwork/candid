/**
 * Shared Claude Haiku 4.5 call infrastructure for text-extraction parsers.
 *
 * Used by every text-based Haiku integration on Candid (EOC, SBC, future formulary).
 * Locked at Phase 3.1A.1 close; extracted to shared library at Phase 3.2 (Task A)
 * per Pattern P-6 hard rule ("New Haiku integrations MUST reference dr3d_dogfood_findings
 * as authority on caching threshold, adaptive max_tokens, defensive post-process,
 * empirical dogfood methodology"). Single source of truth eliminates drift risk
 * across parsers during ongoing soak iterations.
 *
 * Implements the 7 universal mechanisms from Phase 3.1A.1:
 *   - (1) cache_control: ephemeral on system prompt — NO-OP at current prompt sizes:
 *     Claude Haiku 4.5 requires a 4096-token minimum cacheable prefix; current EOC
 *     INSTRUCTIONS are 800-1300 tokens (well below threshold). Empirical Phase 3.1A.1
 *     verification (35 harness rows over $4.27 spend): all rows show
 *     cache_creation_input_tokens=0 + cache_read_input_tokens=0. Directive is left
 *     in place because it engages automatically once prompts grow past 4096 tokens
 *     (e.g., via future few-shot expansion). Padding prompts purely to hit the
 *     threshold is rejected: padding adds full-rate input tokens to every call AND
 *     risks degrading extraction quality (more context = more paraphrase risk).
 *     Source: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 *   - (2) Adaptive max_tokens (input + 4000, capped at HAIKU_MAX_OUTPUT)
 *   - (3) Truncation retry at HAIKU_MAX_OUTPUT
 *   - (4) Stochastic JSON parse retry-once (Phase 3.1B reliability fix)
 *   - jsonrepair fallback + regex JSON extraction inside parseHaikuJSON
 *
 * Cost telemetry: per-call input/output tokens + USD computed via Haiku 4.5 published rates.
 * Mechanisms (5) granular dispatch, (6) cost-cap pre-dispatch guard, (7) Pattern P-8
 * two-pass verifier all live elsewhere — they are parser-orchestrator + verifier
 * concerns, not Haiku-call concerns.
 */

import Anthropic from "@anthropic-ai/sdk";
import { jsonrepair } from "jsonrepair";

export const HAIKU_MODEL = "claude-haiku-4-5-20251001";
export const HAIKU_MAX_OUTPUT = 32000;

// Haiku 4.5 published rates (per 1M tokens). Adjust if model pricing changes.
const HAIKU_INPUT_USD_PER_1M = 0.80;
const HAIKU_OUTPUT_USD_PER_1M = 4.00;
const HAIKU_CACHED_INPUT_USD_PER_1M = 0.08; // 90% discount on cached prefix

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
  try {
    return JSON.parse(cleaned);
  } catch {
    try {
      return JSON.parse(jsonrepair(cleaned));
    } catch (err) {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(jsonrepair(match[0]));
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
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  warnings: string[];
}

/**
 * Call Haiku with cached system prompt + user content.
 * Implements truncation retry + stochastic JSON parse retry.
 *
 * `sectionLabel` is used for log/warning prefixes only; should be a short stable
 * identifier like "eoc/prior_auth_codes" or "sbc/important_questions".
 */
export async function callHaikuWithCache<T>(opts: {
  systemPrompt: string; // cached via cache_control: ephemeral
  userContent: string;
  sectionLabel: string;
  client?: Anthropic;
}): Promise<HaikuCallResult<T>> {
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

  let response = await client.messages.create({ model: HAIKU_MODEL, max_tokens: maxTokens, messages });

  // Truncation detection + retry at HAIKU_MAX_OUTPUT
  if (response.stop_reason === "max_tokens" && maxTokens < HAIKU_MAX_OUTPUT) {
    warnings.push(`haiku_truncation_retry:${opts.sectionLabel}`);
    response = await client.messages.create({ model: HAIKU_MODEL, max_tokens: HAIKU_MAX_OUTPUT, messages });
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
    response = await client.messages.create({ model: HAIKU_MODEL, max_tokens: HAIKU_MAX_OUTPUT, messages });
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

  const costUsd =
    (uncachedInput * HAIKU_INPUT_USD_PER_1M) / 1_000_000 +
    (cacheCreate * HAIKU_INPUT_USD_PER_1M * 1.25) / 1_000_000 + // cache write is 25% premium
    (cacheRead * HAIKU_CACHED_INPUT_USD_PER_1M) / 1_000_000 +
    (outputTokens * HAIKU_OUTPUT_USD_PER_1M) / 1_000_000;

  return { data, inputTokens: uncachedInput + cacheCreate + cacheRead, outputTokens, costUsd, warnings };
}
