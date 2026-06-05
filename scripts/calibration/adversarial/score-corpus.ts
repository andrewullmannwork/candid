// Ing-G.2/3 — validation harness (Ship Gate G2/G3/G4).
//
// Runs the production scorer over the TS-extracted feature vectors (manifest-ts.json)
// and emits a detection-vs-FP CURVE across thresholds — NOT a single operating
// point — broken out by synthetic fidelity tier, with the modified-real blind-spot
// rate and scanned handling measured. A k-fold-on-τ pass reports a selection-bias-
// corrected detection@FP so the headline isn't fit to the test set.
//
//   PRE-DECLARED PASS: at the recommended τ, ≥80% synthetic detection
//                      AND ≤10% real born-digital FP AND 0 scanned-real positives.
//   PRE-DECLARED FAIL: no τ hits 80%@≤10%; OR producer-only crosses τ for any real;
//                      OR any scanned real flagged; OR high-fidelity tier collapses.
//   modified_real ≈0 is the EXPECTED blind spot (not a fail).
//
//   npx tsx scripts/calibration/adversarial/score-corpus.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  scoreAdversarialPdf,
  resolveAdversarialConfig,
  type AdversarialPdfConfig,
} from "@/lib/parser/adversarial-pdf";
import type { AdversarialPdfFeatures } from "@/lib/parser/adversarial-pdf-features";

const DIR = join(process.cwd(), "scripts/calibration/adversarial");
type Row = AdversarialPdfFeatures & Record<string, unknown>;
const manifest: Row[] = JSON.parse(readFileSync(join(DIR, "manifest-ts.json"), "utf8"));

// All corpus docs are SBC-pipeline uploads → realistic classified context.
const CLASSIFIED = "plan_document";

const fidelityTier = (f: unknown): string => {
  const s = String(f ?? "unspecified");
  if (s.startsWith("naive")) return "naive";
  if (s.startsWith("moderate")) return "moderate";
  if (s.startsWith("high")) return "high";
  if (s === "programmatic") return "programmatic";
  return "other";
};

const realBorn = manifest.filter((e) => e.stratum === "real" && !e.image_only);
const realScan = manifest.filter((e) => e.stratum === "real" && e.image_only);
const synthetic = manifest.filter((e) => e.stratum === "synthetic");
const modifiedReal = manifest.filter((e) => e.stratum === "modified_real");

const scoreOf = (e: Row, cfg: AdversarialPdfConfig) => scoreAdversarialPdf(e, CLASSIFIED, cfg);
const cfgAt = (threshold: number) => resolveAdversarialConfig({ threshold });
const detRate = (rows: Row[], t: number) => rows.filter((e) => scoreOf(e, cfgAt(t)).flagged).length / (rows.length || 1);

function main() {
  console.log(`Corpus: ${realBorn.length} real_born · ${realScan.length} real_scan · ${synthetic.length} synthetic · ${modifiedReal.length} modified_real\n`);

  // ── 1. Detection-vs-FP CURVE across τ ──
  console.log("THRESHOLD SWEEP (the curve):");
  console.log(`${"τ".padEnd(6)}${"synth_det".padEnd(11)}${"realFP".padEnd(9)}${"scanFP".padEnd(9)}${"modr_det".padEnd(10)}`);
  const grid = Array.from({ length: 19 }, (_, i) => +((i + 1) * 0.05).toFixed(2));
  for (const t of grid) {
    const sd = detRate(synthetic, t), rfp = detRate(realBorn, t), scfp = detRate(realScan, t), md = detRate(modifiedReal, t);
    const flag = rfp <= 0.1 && sd >= 0.8 ? "  ← meets gate" : "";
    console.log(`${t.toFixed(2).padEnd(6)}${`${(sd * 100).toFixed(0)}%`.padEnd(11)}${`${(rfp * 100).toFixed(0)}%`.padEnd(9)}${`${(scfp * 100).toFixed(0)}%`.padEnd(9)}${`${(md * 100).toFixed(0)}%`.padEnd(10)}${flag}`);
  }

  // ── 2. Recommended τ: max synthetic detection s.t. real_born FP ≤ 10%, prefer a plateau ──
  const feasible = grid.filter((t) => detRate(realBorn, t) <= 0.1);
  const best = feasible.reduce((a, t) => (detRate(synthetic, t) > detRate(synthetic, a) ? t : a), feasible[0] ?? 0.5);
  // widen to the plateau: highest τ still within 2pp detection of best (more robust/conservative)
  const bestDet = detRate(synthetic, best);
  const plateau = feasible.filter((t) => bestDet - detRate(synthetic, t) <= 0.02);
  const recT = plateau.length ? Math.max(...plateau) : best;
  console.log(`\nRecommended τ = ${recT} (plateau ${plateau.length ? `${Math.min(...plateau)}–${Math.max(...plateau)}` : "n/a"})`);

  // ── 3. By-fidelity detection at recommended τ (the honest hard tier) ──
  console.log(`\nDETECTION BY FIDELITY @ τ=${recT}:`);
  const tiers = ["naive", "moderate", "high", "programmatic", "other"];
  for (const tier of tiers) {
    const rows = synthetic.filter((e) => fidelityTier(e.fidelity) === tier);
    if (!rows.length) continue;
    console.log(`  ${tier.padEnd(13)} ${rows.filter((e) => scoreOf(e, cfgAt(recT)).flagged).length}/${rows.length} detected`);
  }
  console.log(`  ${"modified_real".padEnd(13)} ${modifiedReal.filter((e) => scoreOf(e, cfgAt(recT)).flagged).length}/${modifiedReal.length} detected (blind spot — expect ~0)`);

  // ── 4. Headline @ recommended τ ──
  console.log(`\n@ τ=${recT}:  synthetic detection ${(detRate(synthetic, recT) * 100).toFixed(0)}%  |  real_born FP ${(detRate(realBorn, recT) * 100).toFixed(0)}%  |  scanned flagged ${realScan.filter((e) => scoreOf(e, cfgAt(recT)).flagged).length}/${realScan.length}`);

  // ── 5. Scanned assessability (must be unassessable, never positive) ──
  const scanAssessable = realScan.filter((e) => scoreOf(e, cfgAt(recT)).assessable).length;
  console.log(`Scanned reals: ${scanAssessable}/${realScan.length} assessable (expect 0 → routed to unassessable bucket, never synthetic-positive)`);

  // ── 6. Producer-only dispositiveness guard (no real flagged on producer alone) ──
  const producerOnlyCfg = resolveAdversarialConfig({ threshold: recT, weights: { structural: 0, fonts: 0, thin: 0, producer: 0.12 } });
  const realFlaggedByProducerAlone = realBorn.filter((e) => scoreAdversarialPdf(e, CLASSIFIED, producerOnlyCfg).flagged).length;
  console.log(`Producer-only guard: ${realFlaggedByProducerAlone} real_born flagged by producer alone (must be 0)`);

  // ── 7. k-fold-on-τ (selection-bias-corrected detection@FP) ──
  const kfold = (k: number) => {
    const labeled = [...realBorn.map((e) => ({ e, pos: false })), ...synthetic.map((e) => ({ e, pos: true }))];
    let detSum = 0, fpSum = 0;
    for (let f = 0; f < k; f++) {
      const test = labeled.filter((_, i) => i % k === f);
      const train = labeled.filter((_, i) => i % k !== f);
      const trainReal = train.filter((d) => !d.pos), trainSyn = train.filter((d) => d.pos);
      // pick τ on TRAIN: max synthetic detection s.t. train real FP ≤ 10%
      const tFeasible = grid.filter((t) => trainReal.filter((d) => scoreOf(d.e, cfgAt(t)).flagged).length / (trainReal.length || 1) <= 0.1);
      const tStar = tFeasible.reduce((a, t) => {
        const da = trainSyn.filter((d) => scoreOf(d.e, cfgAt(a)).flagged).length;
        const dt = trainSyn.filter((d) => scoreOf(d.e, cfgAt(t)).flagged).length;
        return dt > da ? t : a;
      }, tFeasible[0] ?? 0.5);
      const testReal = test.filter((d) => !d.pos), testSyn = test.filter((d) => d.pos);
      detSum += testSyn.filter((d) => scoreOf(d.e, cfgAt(tStar)).flagged).length / (testSyn.length || 1);
      fpSum += testReal.filter((d) => scoreOf(d.e, cfgAt(tStar)).flagged).length / (testReal.length || 1);
    }
    return { det: detSum / k, fp: fpSum / k };
  };
  const cv = kfold(5);
  console.log(`\n5-fold-on-τ (selection-bias-corrected): detection ${(cv.det * 100).toFixed(0)}%  |  real FP ${(cv.fp * 100).toFixed(0)}%`);

  // ── 8. Verdict ──
  const passHeadline = detRate(synthetic, recT) >= 0.8 && detRate(realBorn, recT) <= 0.1;
  const passScan = realScan.filter((e) => scoreOf(e, cfgAt(recT)).flagged).length === 0;
  const passProducer = realFlaggedByProducerAlone === 0;
  console.log(`\nPRE-DECLARED GATE: headline ${passHeadline ? "PASS" : "FAIL"} · scanned-no-FP ${passScan ? "PASS" : "FAIL"} · producer-not-dispositive ${passProducer ? "PASS" : "FAIL"}`);
}

main();
