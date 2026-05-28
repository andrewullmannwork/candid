/**
 * I7 backfill — Haiku tool-use generalization across 4 non-OAP calibration docs.
 *
 * I2 confirmed tool-use works on OAP. This validates that result generalizes
 * across PPO + HMO + different layouts. Same JSON Schema as I2 (basic; PR3 will
 * add enum constraints + null_justification per G4+G5+Option C).
 *
 * Output per doc: vault/.../<doc>/haiku-tool-use-i7.json
 * Total cost ~$0.06; ~30s runtime.
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

// Same schema as I2 — basic (additionalProperties: true tested in I8 later if needed)
const fieldMetaSchema = {
  type: 'object',
  properties: {
    value: { type: ['string', 'number', 'boolean', 'null'] },
    source_excerpt: { type: ['string', 'null'] },
    source_section_hint: { type: ['string', 'null'] },
    confidence: { type: ['number', 'null'] },
  },
  required: ['value'],
  additionalProperties: false,
};

const planIdentityToolSchema = {
  type: 'object',
  properties: {
    planName: fieldMetaSchema,
    insurerName: fieldMetaSchema,
    planYear: fieldMetaSchema,
    planType: fieldMetaSchema,
    networkType: fieldMetaSchema,
    metalTier: fieldMetaSchema,
    groupNumber: fieldMetaSchema,
    deductibleIndividual: fieldMetaSchema,
    deductibleFamily: fieldMetaSchema,
    outDeductibleIndividual: fieldMetaSchema,
    outDeductibleFamily: fieldMetaSchema,
    oopMaxIndividual: fieldMetaSchema,
    oopMaxFamily: fieldMetaSchema,
    outOopMaxIndividual: fieldMetaSchema,
    outOopMaxFamily: fieldMetaSchema,
    isAcaCompliant: fieldMetaSchema,
    acaComplianceBasis: fieldMetaSchema,
  },
  required: [
    'planName', 'insurerName', 'planYear', 'planType', 'networkType',
    'metalTier', 'groupNumber',
    'deductibleIndividual', 'deductibleFamily',
    'outDeductibleIndividual', 'outDeductibleFamily',
    'oopMaxIndividual', 'oopMaxFamily',
    'outOopMaxIndividual', 'outOopMaxFamily',
    'isAcaCompliant', 'acaComplianceBasis',
  ],
  additionalProperties: false,
};

async function main() {
  const base = extractBaseInstructions();
  const supp = extractFederalSbcSupplement();
  const systemPrompt = base + supp;
  console.log(`System prompt: ${systemPrompt.length} chars`);
  console.log(`Temperature: 0; tool-use enforced (tool_choice: 'tool')`);
  console.log();

  let totalCost = 0;
  for (const doc of DOCS_TO_BACKFILL) {
    const ocrPath = resolve(VAULT_BASE, doc, 'ocr.txt');
    const ocr = readFileSync(ocrPath, 'utf-8');
    console.log(`\n=== ${doc} (OCR ${ocr.length} chars) ===`);
    const start = Date.now();
    let response;
    try {
      response = await client.messages.create({
        model: HAIKU_MODEL,
        max_tokens: 8000,
        temperature: 0,
        system: systemPrompt,
        tools: [
          {
            name: 'emit_plan_identity',
            description: 'Emit the structured plan-identity extraction with all 17 canonical fields. Each field is a {value, source_excerpt, source_section_hint, confidence} object. Use null when the field is not stated in the document.',
            input_schema: planIdentityToolSchema as unknown as Anthropic.Tool.InputSchema,
          },
        ],
        tool_choice: { type: 'tool', name: 'emit_plan_identity' },
        messages: [{ role: 'user', content: ocr }],
      });
    } catch (err) {
      console.error(`  ERROR: ${(err as Error).message}`);
      const outPath = resolve(VAULT_BASE, doc, 'haiku-tool-use-i7.json');
      writeFileSync(outPath, JSON.stringify({
        ts: new Date().toISOString(),
        doc,
        error: (err as Error).message,
        elapsed_ms: Date.now() - start,
      }, null, 2));
      continue;
    }
    const elapsed_ms = Date.now() - start;
    const cost = (response.usage.input_tokens * 0.8) / 1_000_000 + (response.usage.output_tokens * 4.0) / 1_000_000;
    totalCost += cost;
    const toolUseBlock = response.content.find((b) => b.type === 'tool_use');
    if (!toolUseBlock || toolUseBlock.type !== 'tool_use') {
      console.log(`  no tool_use block; stop_reason=${response.stop_reason}`);
      const outPath = resolve(VAULT_BASE, doc, 'haiku-tool-use-i7.json');
      writeFileSync(outPath, JSON.stringify({
        ts: new Date().toISOString(),
        doc,
        error: 'no_tool_use_block',
        stop_reason: response.stop_reason,
        elapsed_ms,
        usage: response.usage,
        cost_usd: cost,
      }, null, 2));
      continue;
    }
    const tool_input = toolUseBlock.input as Record<string, unknown>;
    const keyCount = Object.keys(tool_input).length;
    console.log(`  tool_use returned ${keyCount}/17 keys; elapsed=${elapsed_ms}ms; $${cost.toFixed(4)}`);
    const outPath = resolve(VAULT_BASE, doc, 'haiku-tool-use-i7.json');
    writeFileSync(outPath, JSON.stringify({
      ts: new Date().toISOString(),
      doc,
      model: HAIKU_MODEL,
      sdk: '0.86.1',
      elapsed_ms,
      usage: response.usage,
      cost_usd: cost,
      stop_reason: response.stop_reason,
      tool_name: toolUseBlock.name,
      tool_input,
    }, null, 2));
  }

  console.log(`\nTotal cost: $${totalCost.toFixed(4)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
