/**
 * Main entry point — load states per site, derive ground truth, score, generate outputs.
 *
 * Usage:
 *   npx tsx scripts/calibration/progress-tracker/run.ts
 *
 * Optional CLI args:
 *   --sites=plan_identity,sbc   Limit run to specified sites (comma-separated). Default: all sites.
 *
 * Outputs:
 *   vault/plans/findings/opus-parser-calibration-2026-05-28/progress-tracker.json (combined)
 *   vault/plans/findings/opus-parser-calibration-2026-05-28/progress-tracker.md (combined)
 *
 * The harness is offline — no API spend; reads artifacts from disk, scores, writes
 * markdown. Calibration runs themselves live in `scripts/calibration/runners/*.ts`.
 */

import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { PARSER_SITES, PARSER_SITE_REGISTRY } from './types';
import type { ParserSite, ProgressTracker, StateScore } from './types';
import { loadStatesForSite, loadOcr } from './state-loader';
import { applyGoldOverrides, deriveGroundTruth, loadGoldOverrides, summarizeGroundTruth } from './ground-truth';
import { scoreState } from './scorer';
import { generateMd, type SiteSectionInput } from './md-generator';

const VAULT_BASE =
  '/Users/andrewullmann/Desktop/du_weldenvarden/04_Professional/Airgetlam Labs LLC/Candid/plans/findings/opus-parser-calibration-2026-05-28';

function parseSitesArg(): ParserSite[] {
  const flag = process.argv.find((a) => a.startsWith('--sites='));
  if (!flag) return [...PARSER_SITES];
  const requested = flag.slice('--sites='.length).split(',').map((s) => s.trim());
  const valid: ParserSite[] = [];
  for (const s of requested) {
    if ((PARSER_SITES as readonly string[]).includes(s)) {
      valid.push(s as ParserSite);
    } else {
      console.warn(`[run] Ignoring unknown site: ${s}`);
    }
  }
  return valid.length > 0 ? valid : [...PARSER_SITES];
}

async function main() {
  console.log('=== Calibration Progress Tracker (multi-site) ===\n');

  const sitesToRun = parseSitesArg();
  console.log(`Sites to run: ${sitesToRun.join(', ')}`);
  console.log('');

  const siteInputs: SiteSectionInput[] = [];
  const combinedSites: ProgressTracker['sites'] = [];
  const overrides = loadGoldOverrides();
  const overrideSiteCount = Object.keys(overrides).length;
  if (overrideSiteCount > 0) console.log(`Loaded gold-overrides for ${overrideSiteCount} sites\n`);

  for (const site of sitesToRun) {
    const cfg = PARSER_SITE_REGISTRY[site];
    console.log(`── Site: ${site} ──`);

    // 1. Load states
    const states = loadStatesForSite(site);
    console.log(`  Loaded ${states.length} states`);
    for (const s of states) {
      const docsCovered = Object.keys(s.by_doc).length;
      const totalRuns = Object.values(s.by_doc).reduce((sum, runs) => sum + (runs?.length ?? 0), 0);
      console.log(`    - ${s.id}: ${docsCovered}/${cfg.doc_slugs.length} docs, ${totalRuns} runs`);
    }
    if (states.length === 0) {
      console.log(`  No states for ${site} yet; skipping.\n`);
      continue;
    }

    // 2. Load OCR / input text per unit
    const ocrByDoc: Record<string, string> = {};
    for (const unit of cfg.doc_slugs) {
      try {
        ocrByDoc[unit] = loadOcr(site, unit);
      } catch (err) {
        // Missing OCR is non-fatal — scorer marks excerpts unverifiable; harness still runs.
        ocrByDoc[unit] = '';
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`  [load_ocr_miss] ${site}/${unit}: ${msg}`);
      }
    }

    // 3. Derive ground truth via Option E + apply gold-overrides overlay (per-site)
    const derivedGt = deriveGroundTruth(states, site);
    const groundTruth = applyGoldOverrides(derivedGt, overrides, site);
    const gtSummary = summarizeGroundTruth(groundTruth);
    console.log(`  GT: yes=${gtSummary.total.yes} no=${gtSummary.total.no} ambiguous=${gtSummary.total.ambiguous} unknown=${gtSummary.total.unknown}`);

    // 4. Score each state
    const scores: StateScore[] = [];
    for (const state of states) {
      const sc = scoreState({ state, ocrByDoc, groundTruth, allStates: states });
      scores.push(sc);
      const totalVerified = Object.values(sc.by_doc).reduce((s, d) => s + (d?.fields_verifiable ?? 0), 0);
      const totalDocs = Object.keys(sc.by_doc).length;
      const possibleMax = totalDocs * cfg.canonical_fields.length;
      console.log(`    ${state.id}: ${totalVerified}/${possibleMax} fields verifiable across ${totalDocs} docs`);
    }

    siteInputs.push({ site, scores, states, groundTruth });
    combinedSites.push({
      site,
      label: cfg.label,
      docs: cfg.doc_slugs,
      canonical_fields: cfg.canonical_fields,
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
    });
    console.log('');
  }

  // 5. Generate combined outputs
  console.log('── Writing combined outputs ──');
  const tracker: ProgressTracker = {
    schema_version: 2,
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
      'value_correct_count',
      'value_wrong_count',
      'value_verified_absent_count',
      'value_false_positive_count',
    ],
    sites: combinedSites,
  };

  const jsonPath = resolve(VAULT_BASE, 'progress-tracker.json');
  writeFileSync(jsonPath, JSON.stringify(tracker, null, 2));
  console.log(`  Wrote: ${jsonPath}`);

  const md = generateMd(siteInputs);
  const mdPath = resolve(VAULT_BASE, 'progress-tracker.md');
  writeFileSync(mdPath, md);
  console.log(`  Wrote: ${mdPath}`);

  // 6. Quick top-line summary across all sites
  console.log('\n=== CROSS-SITE TOP-LINE SUMMARY ===');
  for (const input of siteInputs) {
    const cfg = PARSER_SITE_REGISTRY[input.site];
    const defectScore = input.scores.find((s) => s.state_id === cfg.defect_floor_state_id);
    if (!defectScore) {
      console.log(`  ${input.site}: no DEFECT floor state loaded yet`);
      continue;
    }
    const defectSum = Object.values(defectScore.by_doc).reduce(
      (s, d) => s + (d?.fields_verifiable ?? 0),
      0,
    );
    let bestSum = defectSum;
    let bestId = defectScore.state_id;
    for (const sc of input.scores) {
      if (sc.state_id === cfg.defect_floor_state_id) continue;
      if (sc.state_id.startsWith('opus-')) continue;
      if (sc.state_id.startsWith('haiku-comprehensive-')) continue;
      const sum = Object.values(sc.by_doc).reduce((s, d) => s + (d?.fields_verifiable ?? 0), 0);
      if (sum > bestSum) {
        bestSum = sum;
        bestId = sc.state_id;
      }
    }
    const possibleMax = cfg.doc_slugs.length * cfg.canonical_fields.length;
    const delta = bestSum - defectSum;
    const verdict = delta > 0 ? 'IMPROVED' : delta < 0 ? 'REGRESSED' : 'NEUTRAL';
    console.log(`  ${input.site}: DEFECT ${defectSum}/${possibleMax} → best ${bestSum}/${possibleMax} (Δ${delta >= 0 ? '+' : ''}${delta}; ${verdict}; best=${bestId})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
