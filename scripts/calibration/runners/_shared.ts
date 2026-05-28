/**
 * Shared helpers for S138 PR2 calibration runners.
 *
 * Each per-site runner mirrors a parser's system prompt + user content shape,
 * calls Haiku directly with explicit temperature (NOT through callHaikuWithCache
 * to avoid the determinism lock under test), and writes JSON artifacts to the
 * vault calibration dir in the format the harness state-loader expects.
 */

import Anthropic from '@anthropic-ai/sdk';
import { jsonrepair } from 'jsonrepair';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
export const VAULT_BASE =
  '/Users/andrewullmann/Desktop/du_weldenvarden/04_Professional/Airgetlam Labs LLC/Candid/plans/findings/opus-parser-calibration-2026-05-28';

const HAIKU_INPUT_USD_PER_1M = 0.8;
const HAIKU_OUTPUT_USD_PER_1M = 4.0;

export function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Missing ANTHROPIC_API_KEY');
    process.exit(1);
  }
  return new Anthropic({ apiKey, timeout: 180_000, maxRetries: 2 });
}

export interface RunOptions {
  systemPrompt: string;
  userContent: string;
  sectionLabel: string;
  temperature: number;
  maxTokens: number;
  client: Anthropic;
}

export interface RunResult {
  parsed: Record<string, unknown> | null;
  raw: string;
  usage: { input_tokens: number; output_tokens: number };
  elapsed_ms: number;
  cost_usd: number;
  parse_error: string | null;
}

/**
 * Single Haiku call with explicit temperature. Mirrors callHaikuWithCache's
 * cache-control system prompt placement so cost characteristics match PROD.
 */
export async function runHaikuOnce(opts: RunOptions): Promise<RunResult> {
  const start = Date.now();
  let response;
  try {
    response = await opts.client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: opts.systemPrompt,
              cache_control: { type: 'ephemeral' },
            },
            { type: 'text', text: '\n\n' + opts.userContent },
          ],
        },
      ],
    });
  } catch (err) {
    return {
      parsed: null,
      raw: '',
      usage: { input_tokens: 0, output_tokens: 0 },
      elapsed_ms: Date.now() - start,
      cost_usd: 0,
      parse_error: `api_error: ${(err as Error).message}`,
    };
  }

  const text =
    response.content[0]?.type === 'text' ? response.content[0].text : '';
  const usage = {
    input_tokens: response.usage?.input_tokens ?? 0,
    output_tokens: response.usage?.output_tokens ?? 0,
  };
  const cost_usd =
    (usage.input_tokens * HAIKU_INPUT_USD_PER_1M) / 1_000_000 +
    (usage.output_tokens * HAIKU_OUTPUT_USD_PER_1M) / 1_000_000;
  const elapsed_ms = Date.now() - start;

  // Strip code fences + parse JSON, with jsonrepair fallback + balanced-block
  // regex extraction (mirrors src/lib/haiku-client/base.ts parseHaikuJSON to match
  // PROD parser robustness).
  const cleaned = text
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim();
  let parsed: Record<string, unknown> | null = null;
  let parse_error: string | null = null;
  const unwrap = (val: unknown): Record<string, unknown> | null => {
    if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      return val as Record<string, unknown>;
    }
    if (Array.isArray(val)) {
      // Some prompts (description-match) return top-level array; wrap.
      return { items: val } as Record<string, unknown>;
    }
    return null;
  };
  try {
    parsed = unwrap(JSON.parse(cleaned));
    if (!parsed) parse_error = 'top-level not object/array';
  } catch {
    try {
      parsed = unwrap(JSON.parse(jsonrepair(cleaned)));
      if (!parsed) parse_error = 'top-level not object/array (after jsonrepair)';
    } catch {
      // Final fallback: regex-extract first balanced {...} block
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          parsed = unwrap(JSON.parse(jsonrepair(m[0])));
          if (!parsed) parse_error = 'top-level not object/array (after block extract)';
        } catch (err) {
          parse_error = `parse_error_after_block_extract: ${(err as Error).message}`;
        }
      } else {
        // Try array block
        const a = cleaned.match(/\[[\s\S]*\]/);
        if (a) {
          try {
            parsed = unwrap(JSON.parse(jsonrepair(a[0])));
            if (!parsed) parse_error = 'top-level not object/array (after array block)';
          } catch (err) {
            parse_error = `parse_error_after_array_extract: ${(err as Error).message}`;
          }
        } else {
          parse_error = 'no_json_block_found';
        }
      }
    }
  }

  return {
    parsed,
    raw: text,
    usage,
    elapsed_ms,
    cost_usd,
    parse_error,
  };
}

/**
 * Write a calibration artifact to disk. Creates parent dirs if missing.
 */
export function writeArtifact(path: string, result: RunResult): void {
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true });
  }
  writeFileSync(path, JSON.stringify(result, null, 2));
}

/**
 * Convenience: run a single Haiku call at both temp=1.0 (DEFECT floor) and
 * temp=0 (post-PR1 baseline), write both artifacts.
 */
export async function runBothTemperatures(args: {
  systemPrompt: string;
  userContent: string;
  sectionLabel: string;
  maxTokens: number;
  client: Anthropic;
  defectFloorPath: string;
  temp0Path: string;
}): Promise<{ defectFloor: RunResult; temp0: RunResult }> {
  console.log(`  [${args.sectionLabel}] DEFECT floor (temp=1.0)...`);
  const defectFloor = await runHaikuOnce({
    systemPrompt: args.systemPrompt,
    userContent: args.userContent,
    sectionLabel: args.sectionLabel,
    temperature: 1.0,
    maxTokens: args.maxTokens,
    client: args.client,
  });
  writeArtifact(args.defectFloorPath, defectFloor);
  console.log(
    `    ${defectFloor.parse_error ?? `parsed (${Object.keys(defectFloor.parsed ?? {}).length} top-level keys)`} · $${defectFloor.cost_usd.toFixed(4)} · ${defectFloor.elapsed_ms}ms`,
  );

  console.log(`  [${args.sectionLabel}] temp=0 baseline...`);
  const temp0 = await runHaikuOnce({
    systemPrompt: args.systemPrompt,
    userContent: args.userContent,
    sectionLabel: args.sectionLabel,
    temperature: 0,
    maxTokens: args.maxTokens,
    client: args.client,
  });
  writeArtifact(args.temp0Path, temp0);
  console.log(
    `    ${temp0.parse_error ?? `parsed (${Object.keys(temp0.parsed ?? {}).length} top-level keys)`} · $${temp0.cost_usd.toFixed(4)} · ${temp0.elapsed_ms}ms`,
  );

  return { defectFloor, temp0 };
}
