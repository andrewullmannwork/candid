/**
 * I3 — Re-run live PROD bill parser on Dec 12 2022 Swedish bill.
 *
 * Originally targeted claim `f2c36497-525c-46df-9509-eabc5e94398d` but that
 * claim no longer exists in PROD (likely re-uploaded post-S135 cleanup). The
 * Dec 12 2022 bill is currently stored as:
 *   - claim id: `3fa90e73-28cd-4809-8a8a-5d1caae6dd09`
 *   - source_document_id: `40eb588d-04d3-42f2-9012-a75001edd0c5`
 *   - 14 line items, all currently POSITIVE signs (mig 132 backfill + persist.ts Math.abs guard)
 *
 * The PDF byte content is the same — re-running the live PROD Haiku bill parser
 * against this source document should reproduce the original sign-convention
 * behavior (Haiku doesn't see the post-write Math.abs guard).
 *
 * Method: pull the document's OCR/text content (from documents.ocr_text or
 * documents.raw_text or the storage object) + invoke the bill parser prompt
 * verbatim + capture the raw response.
 *
 * Output: artifact saved to vault under plans/findings/bill-parser-sign-...
 */

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';

const apiKey = process.env.ANTHROPIC_API_KEY;
const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!apiKey || !supaUrl || !supaKey) {
  console.error('Missing env vars');
  process.exit(1);
}
const client = new Anthropic({ apiKey });
const supabase = createClient(supaUrl, supaKey, { auth: { persistSession: false } });
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

const SOURCE_DOC_ID = '40eb588d-04d3-42f2-9012-a75001edd0c5';
const CLAIM_ID = '3fa90e73-28cd-4809-8a8a-5d1caae6dd09';
const HAIKU_BILL_PARSER_PATH = '/Users/andrewullmann/Desktop/candid/src/lib/billing/haiku-bill-parser.ts';
const VAULT_OUT_DIR =
  '/Users/andrewullmann/Desktop/du_weldenvarden/04_Professional/Airgetlam Labs LLC/Candid/plans/findings/bill-parser-rerun-2026-05-28';

function extractInstructions(): string {
  const src = readFileSync(HAIKU_BILL_PARSER_PATH, 'utf-8');
  const m = src.match(/const INSTRUCTIONS = `([\s\S]*?)`;/);
  if (!m) throw new Error('Could not extract INSTRUCTIONS from haiku-bill-parser.ts');
  return m[1];
}

async function main() {
  console.log(`Source document: ${SOURCE_DOC_ID}`);
  console.log(`Linked to claim: ${CLAIM_ID} (Dec 12 2022 Swedish bill)`);
  console.log();

  // Pull document row to get OCR text
  const { data: doc, error: docErr } = await supabase
    .from('documents')
    .select('id, file_name, classified_type, status, processing_ocr_text, storage_path, metadata, created_at')
    .eq('id', SOURCE_DOC_ID)
    .maybeSingle();
  if (docErr) {
    console.error('Document fetch error:', docErr.message);
    process.exit(1);
  }
  if (!doc) {
    console.error('Document not found');
    process.exit(1);
  }

  console.log(`Document file_name: ${doc.file_name}`);
  console.log(`Document classified_type: ${doc.classified_type}`);
  console.log(`Document status: ${doc.status}`);
  console.log(`Document processing_ocr_text length: ${(doc.processing_ocr_text || '').length}`);
  console.log(`Document storage_path: ${doc.storage_path || '(not set)'}`);
  console.log(`Document metadata keys: ${Object.keys(doc.metadata || {}).join(', ')}`);

  // Get the text input the live PROD bill parser would use.
  const billText = (doc.processing_ocr_text as string) || '';
  if (!billText) {
    console.error('\nNo processing_ocr_text on document. Need to OCR from storage first — skipping.');
    process.exit(1);
  }
  console.log(`\nUsing bill text from processing_ocr_text (${billText.length} chars)`);
  console.log(`First 500 chars:\n${billText.slice(0, 500)}`);
  console.log('...');

  // Pull line items for cross-reference
  const { data: lineItems } = await supabase
    .from('claim_line_items')
    .select('line_number, description, billing_code, billed_amount, insurance_adjusted_amount, insurance_paid, patient_owes, patient_paid_amount, allowed_amount')
    .eq('claim_id', CLAIM_ID)
    .order('line_number', { ascending: true });
  console.log(`\nCurrent PROD claim_line_items (${lineItems?.length || 0}):`);
  for (const li of lineItems || []) {
    console.log(`  line ${(li.line_number ?? '?')}: code=${li.billing_code} billed=${li.billed_amount} ins_adj=${li.insurance_adjusted_amount} ins_paid=${li.insurance_paid} patient_paid=${li.patient_paid_amount} patient_owes=${li.patient_owes} allowed=${li.allowed_amount}`);
  }

  // Pull claim totals
  const { data: claim } = await supabase
    .from('claims')
    .select('total_billed, total_insurance_adjusted, total_insurance_paid, total_patient_paid, total_patient_responsibility, total_allowed, date_of_service')
    .eq('id', CLAIM_ID)
    .maybeSingle();
  console.log(`\nClaim totals: ${JSON.stringify(claim, null, 2)}`);

  // Now invoke Haiku with the live PROD bill-parser INSTRUCTIONS + the bill text
  const instructions = extractInstructions();
  console.log(`\nBill parser INSTRUCTIONS: ${instructions.length} chars`);
  console.log(`Calling Haiku at temperature=0...`);

  const start = Date.now();
  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 8000,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: instructions, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: '\n\n' + billText },
        ],
      },
    ],
  });
  const elapsed_ms = Date.now() - start;

  const textBlock = response.content.find(b => b.type === 'text');
  const raw = textBlock && textBlock.type === 'text' ? textBlock.text : '';

  console.log(`\nResponse:`);
  console.log(`  Elapsed: ${elapsed_ms}ms`);
  console.log(`  Stop reason: ${response.stop_reason}`);
  console.log(`  Tokens: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out`);
  const cost = (response.usage.input_tokens * 0.8) / 1_000_000 + (response.usage.output_tokens * 4.0) / 1_000_000;
  console.log(`  Cost: $${cost.toFixed(4)}`);
  console.log(`  Raw output (first 800 chars):\n${raw.slice(0, 800)}`);

  // Parse the JSON response
  let cleaned = raw.trim();
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
      parse_error = `Not a JSON object`;
    }
  } catch (err) {
    parse_error = (err as Error).message;
  }

  if (parsed) {
    const lineItemsParsed = (parsed.lineItems || parsed.line_items) as Array<Record<string, unknown>> | undefined;
    console.log(`\n=== HAIKU SIGN-CONVENTION CHECK ===`);
    console.log(`Top-level totals:`, JSON.stringify(parsed.totals, null, 2));
    if (lineItemsParsed && lineItemsParsed.length > 0) {
      console.log(`Line items returned: ${lineItemsParsed.length}`);
      let negSigns = 0;
      for (let i = 0; i < lineItemsParsed.length; i++) {
        const li = lineItemsParsed[i] as Record<string, number | string | unknown>;
        const ins_adj = li.ins_adjusted as number | undefined;
        const ins_paid = li.insurance_paid as number | undefined;
        const billed = li.billed_amount as number | undefined;
        const provider_adj = li.provider_adjusted as number | undefined;
        const flag = (typeof ins_adj === 'number' && ins_adj < 0) || (typeof ins_paid === 'number' && ins_paid < 0);
        if (flag) negSigns += 1;
        console.log(
          `  line ${i + 1}: ` +
          `billed=${billed} ` +
          `ins_adj=${ins_adj} ` +
          `provider_adj=${provider_adj} ` +
          `ins_paid=${ins_paid} ` +
          (flag ? '*** NEGATIVE SIGN ***' : '')
        );
      }
      console.log(`\nNegative-sign violations (ins_adj or ins_paid < 0): ${negSigns} of ${lineItemsParsed.length}`);
    } else {
      console.log('No lineItems/line_items in parsed response');
    }
  } else {
    console.log(`\nParse error: ${parse_error}`);
  }

  // Save artifact
  if (!existsSync(VAULT_OUT_DIR)) mkdirSync(VAULT_OUT_DIR, { recursive: true });
  const outPath = `${VAULT_OUT_DIR}/haiku-bill-parser-rerun-${SOURCE_DOC_ID}.json`;
  writeFileSync(outPath, JSON.stringify({
    ts: new Date().toISOString(),
    source_document_id: SOURCE_DOC_ID,
    claim_id: CLAIM_ID,
    note: 'Originally targeted claim f2c36497 per Andrew direction; that claim deleted in PROD; this is the same Dec 12 2022 Swedish bill under its current claim/document IDs.',
    model: HAIKU_MODEL,
    temperature: 0,
    elapsed_ms,
    usage: response.usage,
    cost_usd: cost,
    stop_reason: response.stop_reason,
    raw_response: raw,
    parsed,
    parse_error,
    current_prod_state: {
      line_items: lineItems,
      claim_totals: claim,
    },
  }, null, 2));
  console.log(`\nArtifact: ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
