/**
 * S138 PR2 calibration runner — sbc site.
 *
 * Mirrors src/lib/sbc/haiku-prompts/important-questions.ts INSTRUCTIONS.
 * Runs against the 4 existing SBC OCRs in vault calibration dir.
 *
 * Vault layout: doc_keyed_with_prefix = `<doc>/sbc-haiku-defect-floor.json` +
 * `<doc>/sbc-haiku-temp-0.json`.
 *
 * Each call: full SBC OCR → Haiku finds important_questions section + extracts
 * 17 plan-identity-scope fields per the prompt's response schema. Output is
 * canonical camelCase keys with {value, source_excerpt, haiku_confidence} per field.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { getClient, runBothTemperatures, VAULT_BASE } from './_shared';

const PROMPT_PATH = '/Users/andrewullmann/Desktop/candid/src/lib/sbc/haiku-prompts/important-questions.ts';
const PREFIX = 'sbc-';
const SBC_DOCS = [
  'oap-buy-up',
  'ambetter-bronze-ppo-ca',
  'gold-80-hmo',
  'anthem-in-17575IN0990006',
] as const;

function extractPromptInstructions(): string {
  const src = readFileSync(PROMPT_PATH, 'utf-8');
  const m = src.match(/const INSTRUCTIONS = `([\s\S]*?)`;/);
  if (!m) throw new Error(`Could not extract INSTRUCTIONS from ${PROMPT_PATH}`);
  return m[1];
}

async function main() {
  console.log('=== S138 PR2 calibration: sbc site ===\n');
  const client = getClient();
  const instructions = extractPromptInstructions();
  console.log(`Prompt: ${instructions.length} chars from ${PROMPT_PATH}\n`);

  let totalCost = 0;

  for (const doc of SBC_DOCS) {
    console.log(`── Doc: ${doc} ──`);
    const ocrPath = resolve(VAULT_BASE, doc, 'ocr.txt');
    const ocr = readFileSync(ocrPath, 'utf-8');
    console.log(`  OCR: ${ocr.length} chars`);

    const { defectFloor, temp0 } = await runBothTemperatures({
      systemPrompt: instructions,
      userContent: ocr,
      sectionLabel: `sbc/${doc}`,
      maxTokens: 8000,
      client,
      defectFloorPath: resolve(VAULT_BASE, doc, `${PREFIX}haiku-defect-floor.json`),
      temp0Path: resolve(VAULT_BASE, doc, `${PREFIX}haiku-temp-0.json`),
    });

    totalCost += defectFloor.cost_usd + temp0.cost_usd;
    console.log('');
  }

  console.log(`Total spend: $${totalCost.toFixed(4)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
