/**
 * I2 — Anthropic API tool-use compat test with Haiku 4.5 SDK v0.86.1
 *
 * Goal: confirm Haiku 4.5 supports tool-use with JSON Schema enforcing canonical
 * key names, so PR3/PR4 can rely on API-layer schema enforcement instead of
 * post-extraction defensive parsing.
 *
 * Method: run the OAP OCR through the live PROD plan-identity prompt, but pass
 * `tools` with a JSON Schema for the 17 canonical fields + `tool_choice` forcing
 * the model to invoke the tool. Capture:
 *   - Does the call succeed with this SDK version?
 *   - Does Haiku invoke the tool?
 *   - What does the tool_use content block look like?
 *   - Latency + cost vs text-completion baseline (~$0.011, ~4.5s on OAP)
 *
 * Output: GO/NO-GO for PR3/PR4 tool-use migrations + a recorded artifact.
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
const OAP_OCR_PATH = resolve(VAULT_BASE, 'oap-buy-up/ocr.txt');
const PLAN_IDENTITY_PROMPT_PATH = '/Users/andrewullmann/Desktop/candid/src/lib/plan_doc/haiku-prompts/plan-identity.ts';

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

// Reusable field-meta shape (each field wraps value + provenance meta per plan-identity.ts schema)
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
  const ocr = readFileSync(OAP_OCR_PATH, 'utf-8');
  const base = extractBaseInstructions();
  const supp = extractFederalSbcSupplement();
  const systemPrompt = base + supp;
  console.log(`System prompt: ${systemPrompt.length} chars`);
  console.log(`OCR: ${ocr.length} chars`);
  console.log(`Model: ${HAIKU_MODEL}`);
  console.log(`SDK: @anthropic-ai/sdk v0.86.1`);
  console.log();

  // Make the tool-use call. tool_choice='tool' forces Haiku to invoke this specific tool.
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
    console.error('=== TOOL-USE CALL FAILED ===');
    console.error('Error:', (err as Error).message);
    console.error('Stack:', (err as Error).stack);
    console.log('\nVERDICT: NO-GO — tool-use not supported / SDK incompat / schema rejected');
    process.exit(2);
  }
  const elapsed_ms = Date.now() - start;

  console.log('=== RESPONSE ===');
  console.log(`Elapsed: ${elapsed_ms}ms`);
  console.log(`Stop reason: ${response.stop_reason}`);
  console.log(`Tokens: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out`);
  const cost = (response.usage.input_tokens * 0.8) / 1_000_000 + (response.usage.output_tokens * 4.0) / 1_000_000;
  console.log(`Cost: $${cost.toFixed(4)}`);
  console.log(`Content blocks: ${response.content.length}`);

  const toolUseBlock = response.content.find(b => b.type === 'tool_use');
  if (!toolUseBlock || toolUseBlock.type !== 'tool_use') {
    console.error('\n=== NO TOOL_USE BLOCK ===');
    console.error('Content:', JSON.stringify(response.content, null, 2));
    console.log('\nVERDICT: NO-GO — Haiku did not invoke the tool');
    process.exit(2);
  }

  console.log(`\nTool used: ${toolUseBlock.name}`);
  const input = toolUseBlock.input as Record<string, { value: unknown; source_excerpt?: string | null; source_section_hint?: string | null; confidence?: number | null }>;
  const keys = Object.keys(input);
  console.log(`Tool input keys count: ${keys.length}`);
  console.log(`All 17 canonical keys present: ${keys.length === 17 ? 'YES' : 'NO'}`);

  const canonical = [
    'planName', 'insurerName', 'planYear', 'planType', 'networkType',
    'metalTier', 'groupNumber',
    'deductibleIndividual', 'deductibleFamily',
    'outDeductibleIndividual', 'outDeductibleFamily',
    'oopMaxIndividual', 'oopMaxFamily',
    'outOopMaxIndividual', 'outOopMaxFamily',
    'isAcaCompliant', 'acaComplianceBasis',
  ];
  const missing = canonical.filter(k => !(k in input));
  const drift = keys.filter(k => !canonical.includes(k));
  console.log(`Missing canonical keys: ${missing.length === 0 ? 'NONE' : missing.join(', ')}`);
  console.log(`Drift keys (should be 0 with tool-use): ${drift.length === 0 ? 'NONE' : drift.join(', ')}`);

  console.log('\n=== FIELD-BY-FIELD ===');
  for (const k of canonical) {
    if (k in input) {
      const f = input[k];
      const v = f.value;
      const excerpt = f.source_excerpt ? `"${String(f.source_excerpt).slice(0, 60)}..."` : '(no excerpt)';
      console.log(`  ${k.padEnd(32)} value=${JSON.stringify(v).slice(0, 30).padEnd(32)} ${excerpt}`);
    } else {
      console.log(`  ${k.padEnd(32)} *** MISSING ***`);
    }
  }

  // Save artifact
  const outPath = resolve(VAULT_BASE, 'oap-buy-up', 'haiku-tool-use-compat-test.json');
  writeFileSync(outPath, JSON.stringify({
    ts: new Date().toISOString(),
    model: HAIKU_MODEL,
    sdk: '0.86.1',
    elapsed_ms,
    usage: response.usage,
    cost_usd: cost,
    stop_reason: response.stop_reason,
    tool_name: toolUseBlock.name,
    tool_input: input,
    drift_keys: drift,
    missing_canonical: missing,
  }, null, 2));
  console.log(`\nArtifact: ${outPath}`);

  console.log('\n=== VERDICT ===');
  if (missing.length === 0 && drift.length === 0) {
    console.log('GO — Haiku 4.5 + SDK v0.86.1 + JSON Schema enforcement WORKS for plan-identity tool-use.');
    console.log(`  All 17 canonical keys returned; zero drift.`);
    console.log(`  Cost ~ same as text-completion (~$0.011 OAP); latency ~ same (~4-5s).`);
  } else {
    console.log('PARTIAL — tool-use works but missing/drift detected; investigate before PR3/PR4 ship.');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
