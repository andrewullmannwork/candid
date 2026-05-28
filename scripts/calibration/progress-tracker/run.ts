/**
 * Main entry point — load states, derive ground truth, score, generate outputs.
 *
 * Usage:
 *   set -a && source .env.local && set +a  # (env not strictly needed; harness is offline)
 *   npx tsx scripts/calibration/progress-tracker/run.ts
 *
 * Outputs:
 *   vault/plans/findings/opus-parser-calibration-2026-05-28/progress-tracker.json
 *   vault/plans/findings/opus-parser-calibration-2026-05-28/progress-tracker.md
 */

import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { CALIBRATION_DOCS, CANONICAL_PLAN_IDENTITY_FIELDS } from './types';
import type { DocSlug, ProgressTracker, StateScore } from './types';
import { loadKnownStates, loadOcr } from './state-loader';
import { applyGoldOverrides, deriveGroundTruth, loadGoldOverrides, summarizeGroundTruth } from './ground-truth';
import { scoreState } from './scorer';
import { generateMd } from './md-generator';

const VAULT_BASE =
  '/Users/andrewullmann/Desktop/du_weldenvarden/04_Professional/Airgetlam Labs LLC/Candid/plans/findings/opus-parser-calibration-2026-05-28';

async function main() {
  console.log('=== Calibration Progress Tracker ===\n');

  // 1. Load known states from disk
  console.log('Step 1: Loading states from disk...');
  const states = loadKnownStates();
  console.log(`  Loaded ${states.length} states:`);
  for (const s of states) {
    const docsCovered = Object.keys(s.by_doc).length;
    const totalRuns = Object.values(s.by_doc).reduce((sum, runs) => sum + (runs?.length ?? 0), 0);
    console.log(`    - ${s.id}: ${docsCovered}/${CALIBRATION_DOCS.length} docs, ${totalRuns} runs`);
  }

  // 2. Load OCR text per doc
  console.log('\nStep 2: Loading OCR text per doc...');
  const ocrByDoc: Record<DocSlug, string> = {} as Record<DocSlug, string>;
  for (const doc of CALIBRATION_DOCS) {
    ocrByDoc[doc] = loadOcr(doc);
    console.log(`  ${doc}: ${ocrByDoc[doc].length} chars`);
  }

  // 3. Derive ground truth via Option E + apply gold-overrides overlay
  console.log('\nStep 3: Deriving ground truth (Option E)...');
  const derivedGt = deriveGroundTruth(states);
  const overrides = loadGoldOverrides();
  const overrideCount = Object.values(overrides).reduce(
    (s, fields) => s + Object.keys(fields ?? {}).length,
    0,
  );
  if (overrideCount > 0) console.log(`  Applying ${overrideCount} gold-override entries...`);
  const groundTruth = applyGoldOverrides(derivedGt, overrides);
  const gtSummary = summarizeGroundTruth(groundTruth);
  console.log(`  Per-doc ground truth distribution:`);
  for (const [doc, counts] of Object.entries(gtSummary.per_doc)) {
    console.log(`    ${doc}: yes=${counts.yes} no=${counts.no} ambiguous=${counts.ambiguous} unknown=${counts.unknown} (single_source=${counts.single_source})`);
  }
  console.log(`  Total: yes=${gtSummary.total.yes} no=${gtSummary.total.no} ambiguous=${gtSummary.total.ambiguous} unknown=${gtSummary.total.unknown}`);

  // 4. Score each state
  console.log('\nStep 4: Scoring each state...');
  const scores: StateScore[] = [];
  for (const state of states) {
    const sc = scoreState({ state, ocrByDoc, groundTruth, allStates: states });
    scores.push(sc);
    const totalVerified = Object.values(sc.by_doc).reduce((s, d) => s + (d?.fields_verifiable ?? 0), 0);
    const totalDocs = Object.keys(sc.by_doc).length;
    const possibleMax = totalDocs * CANONICAL_PLAN_IDENTITY_FIELDS.length;
    console.log(`  ${state.id}: ${totalVerified}/${possibleMax} fields verifiable across ${totalDocs} docs`);
  }

  // 5. Generate outputs
  console.log('\nStep 5: Generating outputs...');
  const tracker: ProgressTracker = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    metrics: [
      'fields_verifiable',
      'verified_null_count',
      'unverifiable_count',
      'spurious_null_count',
      'drift_count',
      'format_failure_count',
      'agreement_with_opus_count',
      'cost_usd_total',
      'latency_ms_p50',
    ],
    docs: CALIBRATION_DOCS,
    canonical_fields: CANONICAL_PLAN_IDENTITY_FIELDS,
    states: states.map((s) => ({
      id: s.id,
      label: s.label,
      date: s.date,
      session: s.session,
      model: s.model,
      prompt: s.prompt,
      temperature: s.temperature,
      tool_use: s.tool_use,
    })),
    scores,
    ground_truth: groundTruth,
  };

  const jsonPath = resolve(VAULT_BASE, 'progress-tracker.json');
  writeFileSync(jsonPath, JSON.stringify(tracker, null, 2));
  console.log(`  Wrote: ${jsonPath}`);

  const md = generateMd({ scores, states, groundTruth });
  const mdPath = resolve(VAULT_BASE, 'progress-tracker.md');
  writeFileSync(mdPath, md);
  console.log(`  Wrote: ${mdPath}`);

  // 6. Quick top-line summary
  console.log('\n=== TOP-LINE PROGRESS SUMMARY ===');
  console.log(`States loaded: ${states.length}`);
  console.log(`Docs covered: ${CALIBRATION_DOCS.length}`);
  console.log(`Canonical fields per doc: ${CANONICAL_PLAN_IDENTITY_FIELDS.length}`);
  console.log();
  console.log('Verifiable fields per state per doc (higher is better; monotonic must hold):');
  const docColW = 22;
  console.log(
    '  ' +
      'state'.padEnd(50) +
      CALIBRATION_DOCS.map((d) => d.slice(0, 18).padEnd(docColW)).join(''),
  );
  for (const sc of scores) {
    const state = states.find((s) => s.id === sc.state_id);
    const label = (state?.label ?? sc.state_id).slice(0, 48);
    const cells = CALIBRATION_DOCS.map((doc) => {
      const ds = sc.by_doc[doc];
      if (!ds) return '—'.padEnd(docColW);
      return `${ds.fields_verifiable}/${CANONICAL_PLAN_IDENTITY_FIELDS.length} (sn=${ds.spurious_null_count}, d=${ds.drift_count}, f=${ds.format_failure_count})`.padEnd(docColW);
    }).join('');
    console.log('  ' + label.padEnd(50) + cells);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
