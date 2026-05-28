/**
 * I1 + I6 — temp=0 drift probe across 5 calibration docs.
 *
 * I1: OAP Buy Up — 5 runs at temperature=0 (vs 40% format-failure baseline at temp=1.0)
 * I6: 4 other calibration docs — 1 run each at temperature=0
 *
 * Measures:
 *   - keys_total (how many fields returned)
 *   - drift_count (keys not in canonical schema — semantic equivalents)
 *   - null_count (canonical keys returned with value=null)
 *   - format_failure (response not a parseable JSON object with the expected shape)
 *
 * Output:
 *   - per-run JSON saved to vault calibration dir
 *   - summary table printed to stdout
 *
 * Reuses BASE_INSTRUCTIONS + FEDERAL_SBC_TABULAR_SUPPLEMENT extraction logic
 * from oap-live-prod-prompt-haiku-2026-05-28.ts to keep the prompt identical
 * to live PROD plan_doc.
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

const CANONICAL_KEYS_17 = [
  'planName', 'insurerName', 'planYear', 'planType', 'networkType',
  'metalTier', 'groupNumber',
  'deductibleIndividual', 'deductibleFamily',
  'outDeductibleIndividual', 'outDeductibleFamily',
  'oopMaxIndividual', 'oopMaxFamily',
  'outOopMaxIndividual', 'outOopMaxFamily',
  'isAcaCompliant', 'acaComplianceBasis',
];

interface DocSpec {
  slug: string;
  runs: number;
}

const DOCS: DocSpec[] = [
  { slug: 'oap-buy-up', runs: 5 },              // I1
  { slug: 'ambetter-bronze-ppo-ca', runs: 1 },  // I6
  { slug: 'gold-80-hmo', runs: 1 },             // I6
  { slug: 'anthem-in-17575IN0990006', runs: 1 },// I6
  { slug: 'ecm-eoc', runs: 1 },                 // I6
];

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

interface RunResult {
  doc: string;
  run_idx: number;
  elapsed_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  keys_total: number;
  canonical_present: number;
  canonical_null: number;
  drift_keys: string[];
  parse_error: string | null;
  raw_first_200: string;
}

async function runHaikuTemp0(ocrText: string, systemPrompt: string, label: string): Promise<{
  parsed: Record<string, unknown> | null;
  raw: string;
  usage: { input_tokens: number; output_tokens: number };
  elapsed_ms: number;
  parse_error: string | null;
}> {
  const start = Date.now();
  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 8000,
    temperature: 0,
    system: systemPrompt,
    messages: [{ role: 'user', content: ocrText }],
  });
  const elapsed_ms = Date.now() - start;
  const textBlock = response.content.find(b => b.type === 'text');
  const raw = textBlock && textBlock.type === 'text' ? textBlock.text.trim() : '';
  let cleaned = raw;
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '').trim();
  }
  let parsed: Record<string, unknown> | null = null;
  let parse_error: string | null = null;
  try {
    const obj = JSON.parse(cleaned);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      parsed = obj as Record<string, unknown>;
    } else {
      parse_error = `Not a JSON object — got ${Array.isArray(obj) ? 'array' : typeof obj}`;
    }
  } catch (err) {
    parse_error = (err as Error).message;
  }
  return {
    parsed,
    raw,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
    elapsed_ms,
    parse_error,
  };
}

function analyzeResponse(parsed: Record<string, unknown> | null): {
  keys_total: number;
  canonical_present: number;
  canonical_null: number;
  drift_keys: string[];
} {
  if (!parsed) return { keys_total: 0, canonical_present: 0, canonical_null: 0, drift_keys: [] };
  const keys = Object.keys(parsed);
  const drift_keys = keys.filter(k => !CANONICAL_KEYS_17.includes(k));
  const canonical_keys_returned = keys.filter(k => CANONICAL_KEYS_17.includes(k));
  let canonical_null = 0;
  let canonical_present = 0;
  for (const k of canonical_keys_returned) {
    const field = parsed[k] as { value?: unknown } | unknown;
    const value = (field && typeof field === 'object' && 'value' in (field as object))
      ? (field as { value: unknown }).value
      : field;
    if (value === null || value === undefined) {
      canonical_null += 1;
    } else {
      canonical_present += 1;
    }
  }
  return {
    keys_total: keys.length,
    canonical_present,
    canonical_null,
    drift_keys,
  };
}

async function main() {
  const base = extractBaseInstructions();
  const supp = extractFederalSbcSupplement();
  const systemPrompt = base + supp;
  console.log(`System prompt: ${systemPrompt.length} chars`);
  console.log(`temperature: 0 (vs API default 1.0)`);
  console.log(`Model: ${HAIKU_MODEL}`);
  console.log();

  const results: RunResult[] = [];

  for (const doc of DOCS) {
    const ocrPath = resolve(VAULT_BASE, doc.slug, 'ocr.txt');
    const ocr = readFileSync(ocrPath, 'utf-8');
    console.log(`\n=== ${doc.slug} (${doc.runs} runs at temp=0; OCR ${ocr.length} chars) ===`);
    for (let i = 1; i <= doc.runs; i++) {
      const label = `${doc.slug}#${i}`;
      try {
        const { parsed, raw, usage, elapsed_ms, parse_error } = await runHaikuTemp0(ocr, systemPrompt, label);
        const stats = analyzeResponse(parsed);
        const inputUsd = (usage.input_tokens * 0.80) / 1_000_000;
        const outputUsd = (usage.output_tokens * 4.00) / 1_000_000;
        const cost_usd = inputUsd + outputUsd;
        results.push({
          doc: doc.slug,
          run_idx: i,
          elapsed_ms,
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cost_usd,
          keys_total: stats.keys_total,
          canonical_present: stats.canonical_present,
          canonical_null: stats.canonical_null,
          drift_keys: stats.drift_keys,
          parse_error,
          raw_first_200: raw.slice(0, 200),
        });
        const outPath = resolve(VAULT_BASE, doc.slug, `haiku-temp-0-run-${i}.json`);
        writeFileSync(outPath, JSON.stringify({ parsed, raw, usage, elapsed_ms, parse_error }, null, 2));
        console.log(
          `  run ${i}: ` +
          `keys=${stats.keys_total} ` +
          `canon_present=${stats.canonical_present}/17 ` +
          `canon_null=${stats.canonical_null} ` +
          `drift=${stats.drift_keys.length} ` +
          (stats.drift_keys.length > 0 ? `[${stats.drift_keys.slice(0, 3).join(', ')}${stats.drift_keys.length > 3 ? '...' : ''}] ` : '') +
          `parse_err=${parse_error ? 'YES' : 'no'} ` +
          `$${cost_usd.toFixed(4)} ` +
          `${elapsed_ms}ms`
        );
      } catch (err) {
        console.error(`  run ${i}: ERROR ${(err as Error).message}`);
      }
    }
  }

  console.log('\n\n=== SUMMARY ===');
  console.log('doc                                       run  keys  canon  null  drift  parse_err  cost     ms');
  console.log('-'.repeat(105));
  for (const r of results) {
    console.log(
      `${r.doc.padEnd(40)}  ${String(r.run_idx).padStart(3)}  ` +
      `${String(r.keys_total).padStart(4)}  ` +
      `${String(r.canonical_present).padStart(5)}/17  ` +
      `${String(r.canonical_null).padStart(4)}  ` +
      `${String(r.drift_keys.length).padStart(5)}  ` +
      `${(r.parse_error ? 'YES' : 'no').padEnd(9)}  ` +
      `$${r.cost_usd.toFixed(4)}  ${String(r.elapsed_ms).padStart(5)}`
    );
  }

  console.log('\n=== DRIFT KEY DETAIL ===');
  for (const r of results) {
    if (r.drift_keys.length > 0) {
      console.log(`${r.doc} run ${r.run_idx}: ${r.drift_keys.join(', ')}`);
    }
  }

  const totalCost = results.reduce((s, r) => s + r.cost_usd, 0);
  console.log(`\nTotal probe cost: $${totalCost.toFixed(4)}`);

  // Aggregate I1 (OAP only) format-failure rate at temp=0
  const oapRuns = results.filter(r => r.doc === 'oap-buy-up');
  const oapFormatFailures = oapRuns.filter(r => r.parse_error !== null || r.canonical_present + r.canonical_null < 10).length;
  console.log(`\nI1 verdict — OAP at temp=0:`);
  console.log(`  format-failure rate: ${oapFormatFailures}/${oapRuns.length} (${((oapFormatFailures / oapRuns.length) * 100).toFixed(0)}%)`);
  console.log(`  (baseline at temp=1.0 per critical-review §D1: 40% format-failure rate)`);

  // I6 cross-doc drift summary
  console.log(`\nI6 verdict — cross-doc drift at temp=0:`);
  for (const doc of DOCS.filter(d => d.slug !== 'oap-buy-up')) {
    const r = results.find(x => x.doc === doc.slug);
    if (r) {
      console.log(`  ${doc.slug.padEnd(40)} drift_count=${r.drift_keys.length} canon_present=${r.canonical_present}/17 parse_err=${r.parse_error ? 'YES' : 'no'}`);
    }
  }

  const summaryPath = resolve(VAULT_BASE, 'temp-0-drift-results-2026-05-28.json');
  writeFileSync(summaryPath, JSON.stringify({ ts: new Date().toISOString(), temperature: 0, model: HAIKU_MODEL, results }, null, 2));
  console.log(`\nFull results saved to: ${summaryPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
