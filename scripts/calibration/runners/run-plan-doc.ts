/**
 * S138 PR2 calibration runner — plan_doc site.
 *
 * Mirrors src/lib/plan_doc/haiku-prompts/access-instructions.ts INSTRUCTIONS.
 * Runs against the 4 existing SBC OCRs (PR2 scope; plan_doc sub-prompt firing
 * on SBC OCRs is the PROD pattern when classifier routes SBC docs through
 * plan_doc parser path).
 *
 * Vault layout: doc_keyed_with_prefix = `<doc>/plan-doc-haiku-defect-floor.json`
 * + `<doc>/plan-doc-haiku-temp-0.json`.
 *
 * The raw access_instructions response shape includes `domainContacts` as an
 * object (not {value, source_excerpt}). Runner normalizes to harness shape:
 *   - customerServicePhone: pass-through
 *   - networkFinderUrl: pass-through
 *   - domainContactsPresent: synthesize {value: bool, source_excerpt: domainContacts_source_excerpt}
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { getClient, runHaikuOnce, VAULT_BASE, writeArtifact, type RunResult } from './_shared';

const PROMPT_PATH = '/Users/andrewullmann/Desktop/candid/src/lib/plan_doc/haiku-prompts/access-instructions.ts';
const PREFIX = 'plan-doc-';
const PLAN_DOC_DOCS = [
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

function normalize(raw: Record<string, unknown> | null): Record<string, unknown> {
  if (!raw) return {};
  const csp = (raw.customerServicePhone ?? null) as { value?: unknown; source_excerpt?: string } | null;
  const nfu = (raw.networkFinderUrl ?? null) as { value?: unknown; source_excerpt?: string } | null;
  const dc = (raw.domainContacts ?? null) as Record<string, string> | null;
  const dcSource = typeof raw.domainContacts_source_excerpt === 'string'
    ? raw.domainContacts_source_excerpt
    : '';
  const hasDomainContacts = dc !== null && typeof dc === 'object' && Object.keys(dc).length > 0;

  return {
    customerServicePhone: {
      value: csp?.value ?? null,
      source_excerpt: csp?.source_excerpt ?? '',
    },
    networkFinderUrl: {
      value: nfu?.value ?? null,
      source_excerpt: nfu?.source_excerpt ?? '',
    },
    domainContactsPresent: {
      value: hasDomainContacts ? true : null, // null when absent (matches plan-identity null=absent semantics)
      source_excerpt: dcSource,
    },
  };
}

async function main() {
  console.log('=== S138 PR2 calibration: plan_doc site ===\n');
  const client = getClient();
  const instructions = extractPromptInstructions();
  console.log(`Prompt: ${instructions.length} chars from ${PROMPT_PATH}\n`);

  let totalCost = 0;

  for (const doc of PLAN_DOC_DOCS) {
    console.log(`── Doc: ${doc} ──`);
    const ocrPath = resolve(VAULT_BASE, doc, 'ocr.txt');
    const ocr = readFileSync(ocrPath, 'utf-8');
    console.log(`  OCR: ${ocr.length} chars`);

    console.log('  DEFECT floor (temp=1.0)...');
    const defectFloor = await runHaikuOnce({
      systemPrompt: instructions,
      userContent: ocr,
      sectionLabel: `plan_doc/${doc}`,
      temperature: 1.0,
      maxTokens: 2048,
      client,
    });
    const dfPath = resolve(VAULT_BASE, doc, `${PREFIX}haiku-defect-floor.json`);
    writeArtifact(dfPath, {
      ...defectFloor,
      parsed: normalize(defectFloor.parsed),
    } as RunResult);
    console.log(`    ${defectFloor.parse_error ?? 'parsed'} · $${defectFloor.cost_usd.toFixed(4)} · ${defectFloor.elapsed_ms}ms`);

    console.log('  temp=0 baseline...');
    const temp0 = await runHaikuOnce({
      systemPrompt: instructions,
      userContent: ocr,
      sectionLabel: `plan_doc/${doc}`,
      temperature: 0,
      maxTokens: 2048,
      client,
    });
    const t0Path = resolve(VAULT_BASE, doc, `${PREFIX}haiku-temp-0.json`);
    writeArtifact(t0Path, {
      ...temp0,
      parsed: normalize(temp0.parsed),
    } as RunResult);
    console.log(`    ${temp0.parse_error ?? 'parsed'} · $${temp0.cost_usd.toFixed(4)} · ${temp0.elapsed_ms}ms`);

    totalCost += defectFloor.cost_usd + temp0.cost_usd;
    console.log('');
  }

  console.log(`Total spend: $${totalCost.toFixed(4)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
