/**
 * Backfill — Haiku live-PROD plan-identity prompt @ temp=1.0, 5 runs per doc.
 *
 * S136 only captured live-PROD-temp=1.0 for OAP (single run, plus the 5-run
 * critical-review §D1 probe summary). This script fills the gap:
 *   - Ambetter Bronze PPO CA: 5 runs
 *   - Gold 80 HMO: 5 runs
 *   - Anthem IN: 5 runs
 *   - ECM EOC: 5 runs (will likely fail with parse_error at 767K chars; captured as such)
 *
 * Output per doc: vault/.../<doc>/haiku-live-prod-temp1-runs.json with shape
 *   { runs: [{ parsed, raw, usage, elapsed_ms, parse_error }, ...] }
 *
 * Total cost ~$0.22; ~10 min runtime.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Missing ANTHROPIC_API_KEY');
  process.exit(1);
}
const client = new Anthropic({ apiKey });
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

const VAULT_BASE =
  '/Users/andrewullmann/Desktop/du_weldenvarden/04_Professional/Airgetlam Labs LLC/Candid/plans/findings/opus-parser-calibration-2026-05-28';
const PLAN_IDENTITY_PROMPT_PATH = '/Users/andrewullmann/Desktop/candid/src/lib/plan_doc/haiku-prompts/plan-identity.ts';

const DOCS_TO_BACKFILL = [
  'ambetter-bronze-ppo-ca',
  'gold-80-hmo',
  'anthem-in-17575IN0990006',
  'ecm-eoc',
] as const;

const RUNS_PER_DOC = 5;

function extractBaseInstructions(): string {
  const src = readFileSync(PLAN_IDENTITY_PROMPT_PATH, 'utf-8');
  const m = src.match(/const BASE_INSTRUCTIONS = `([\s\S]*?)`;/);
  if (!m) throw new Error('Could not extract BASE_INSTRUCTIONS');
  return m[1];
}

function extractFederalSbcSupplement(): string {
  const src = readFileSync(PLAN_IDENTITY_PROMPT_PATH, 'utf-8');
  const m = src.match(/const FEDERAL_SBC_TABULAR_SUPPLEMENT = `([\s\S]*?)`;/);
  if (!m) throw new Error('Could not extract FEDERAL_SBC_TABULAR_SUPPLEMENT');
  return m[1];
}

async function runOnce(ocr: string, systemPrompt: string): Promise<{
  parsed: Record<string, unknown> | null;
  raw: string;
  usage: { input_tokens: number; output_tokens: number };
  elapsed_ms: number;
  parse_error: string | null;
}> {
  const start = Date.now();
  let response;
  try {
    response = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 8000,
      // temperature: undefined defaults to 1.0 — explicit per Anthropic SDK semantics
      system: systemPrompt,
      messages: [{ role: 'user', content: ocr }],
    });
  } catch (err) {
    return {
      parsed: null,
      raw: '',
      usage: { input_tokens: 0, output_tokens: 0 },
      elapsed_ms: Date.now() - start,
      parse_error: `api_error: ${(err as Error).message}`,
    };
  }
  const elapsed_ms = Date.now() - start;
  const textBlock = response.content.find((b) => b.type === 'text');
  const raw = textBlock && textBlock.type === 'text' ? textBlock.text.trim() : '';
  let cleaned = raw;
  if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '').trim();
  let parsed: Record<string, unknown> | null = null;
  let parse_error: string | null = null;
  try {
    const obj = JSON.parse(cleaned);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      parsed = obj as Record<string, unknown>;
    } else {
      parse_error = `not_a_json_object: ${Array.isArray(obj) ? 'array' : typeof obj}`;
    }
  } catch (err) {
    parse_error = (err as Error).message;
  }
  return {
    parsed,
    raw,
    usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens },
    elapsed_ms,
    parse_error,
  };
}

async function main() {
  const base = extractBaseInstructions();
  const supp = extractFederalSbcSupplement();
  const systemPrompt = base + supp;
  console.log(`System prompt: ${systemPrompt.length} chars`);
  console.log(`Temperature: 1.0 (Anthropic API default)`);
  console.log(`Runs per doc: ${RUNS_PER_DOC}`);
  console.log();

  let totalCost = 0;
  for (const doc of DOCS_TO_BACKFILL) {
    const ocrPath = resolve(VAULT_BASE, doc, 'ocr.txt');
    const ocr = readFileSync(ocrPath, 'utf-8');
    console.log(`\n=== ${doc} (${RUNS_PER_DOC} runs; OCR ${ocr.length} chars) ===`);
    const runs: Array<Awaited<ReturnType<typeof runOnce>>> = [];
    for (let i = 1; i <= RUNS_PER_DOC; i++) {
      const r = await runOnce(ocr, systemPrompt);
      const cost = (r.usage.input_tokens * 0.8) / 1_000_000 + (r.usage.output_tokens * 4.0) / 1_000_000;
      totalCost += cost;
      const keyCount = r.parsed ? Object.keys(r.parsed).length : 0;
      console.log(
        `  run ${i}: keys=${keyCount} parse_err=${r.parse_error ? 'YES' : 'no'} ${r.elapsed_ms}ms $${cost.toFixed(4)}`,
      );
      runs.push(r);
    }
    const outPath = resolve(VAULT_BASE, doc, 'haiku-live-prod-temp1-runs.json');
    writeFileSync(outPath, JSON.stringify({ runs }, null, 2));
    console.log(`  → wrote ${outPath}`);
  }

  console.log(`\nTotal cost: $${totalCost.toFixed(4)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
