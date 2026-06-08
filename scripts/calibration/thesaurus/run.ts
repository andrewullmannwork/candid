/**
 * Service Thesaurus harness — DETERMINISTIC scoring run (no DB, no Haiku).
 * Reads frozen GT + frozen snapshots (produced by resolve-snapshot.ts, the Sonnet step)
 * → buildScoreCard → writes scorecard JSON + markdown to the output dir.
 *
 * Run: npx tsx scripts/calibration/thesaurus/run.ts <snapshot-dir> [baseline-forward.json]
 *   <snapshot-dir> contains: gt.json, forward.json, stored.json, cohorts-snapshot.json, b5-baseline.json, b5-current.json
 *   (+ convergence.json from the N-run producer; optional)
 *
 * Gate (§7.6, S168 reframe): the hard gate is B2-vs-oracle ≥ GATE_B2 + B1 ≥ GATE_B1 on the N-run
 * majority. Pass GATE_B2 / GATE_B1 env to ENFORCE (exit 3 on miss); omit for report-only (Step 4).
 * The before/after ledger is DIAGNOSTIC (two stochastic runs, noise-confounded) — reported, never fatal.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import { buildScoreCard, validateSnapshot } from "./score";
import { loadGt } from "./gt-loader";
import type { ForwardMapEntry, StoredCanonical, CohortSnapshot, B5Counts, ScoreCard, ConvergenceReport } from "./types";

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

function scorecardMd(s: ScoreCard): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const recallRows = (m: Record<string, { recall: number; hits: number; denom: number }>) =>
    Object.entries(m).map(([k, v]) => `| ${k} | ${pct(v.recall)} | ${v.hits}/${v.denom} |`).join("\n");
  return `# Thesaurus scorecard — ${s.phaseLabel}
${s.invalid ? `\n> ⛔ **SCORECARD INVALID** — ${s.invalid.reason}\n> Metrics below are from a DEGENERATE run — do NOT trust them.\n` : ""}
GT version: \`${s.gtVersion}\` · corpus: ${s.corpus.totalGt} GT (${s.corpus.scored} scored · ${s.corpus.noConcept} no-concept · ${s.corpus.negativePairs} neg-pairs · ${s.corpus.notFound} not-found · ${s.corpus.andrewAdjudicated} andrew-adjudicated)

## Headline
| Metric | Value |
|---|---|
| **B1-forward** (resolver recall — moves every phase) | **${pct(s.b1Forward.recall)}** (${s.b1Forward.hits}/${s.b1Forward.denom}) |
| **B1-stored** (canonical coverage — Phase-5 outcome) | ${pct(s.b1Stored.recall)} (${s.b1Stored.hits}/${s.b1Stored.denom}) |
| **B2 precision** (FLOOR, andrew-only) | ${pct(s.b2Precision.precision)} (${s.b2Precision.correct}/${s.b2Precision.mappedAndrew}) |
| B2 false-positive (over-mapping NO_CONCEPT) | ${pct(s.b2Precision.falsePositiveRate)} (${s.b2Precision.falsePositives}/${s.b2Precision.noConceptAndrew}) |
| co-occurrence veto (DEFERRED to Phase 2 — informational, not a Phase-0 gate) | ${s.b2Precision.negativePairViolations} |
| **B3 gap-rate** without backstop | ${pct(s.b3.gapRateWithoutBackstop)} (${s.b3.unkWithout}/${s.b3.totalCells}) |
| B3 gap-rate with backstop | ${pct(s.b3.gapRateWithBackstop)} (${s.b3.unkWith}/${s.b3.totalCells}) |

## S3 zero-regression ledger (vs baseline)
- **regressions (BLOCK ship): ${s.ledger.counts.regressions}**
- improvements: ${s.ledger.counts.improvements} · newly-mapped: ${s.ledger.counts.newlyMapped} · lost: ${s.ledger.counts.lost}
${s.ledger.regressions.slice(0, 20).map((r) => `  - ⚠ ${r.insurer}/${r.docId} "${r.serviceName}": ${r.baselineSlug} → ${r.currentSlug} (correct: ${r.correctSlug})`).join("\n")}

## After-score 3-way split (andrew-only, rename-aware)
- **(a) recovered by the structure**: ${s.threeWay.recovered.count}
- **(b) still-wrong (Phase-2 synonym backlog)**: ${s.threeWay.stillWrong.count}
- **(c) News recover** (no-concept → new-vocab slug; reported APART — semi-circular coverage, not validated precision): ${s.threeWay.newsRecover.count}
${Object.entries(s.threeWay.newsRecover.bySlug).sort((a, b) => b[1].count - a[1].count).map(([slug, v]) => `  - ${slug}: ${v.count}  (e.g. ${v.sampleNames.slice(0, 3).join("; ")})`).join("\n")}

### B2 false-positive split (no-concept andrew mappings)
- genuine over-mapping (→ existing/rename slug): ${s.b2Precision.falsePositives}/${s.b2Precision.noConceptAndrew}
- News recovery (→ new-vocab slug; intended, NOT counted as a false positive): ${s.b2Precision.falsePositivesNewVocab}

### still-wrong sample (Phase-2 synonym backlog)
${s.threeWay.stillWrong.sample.slice(0, 15).map((r) => `  - ${r.insurer}/${r.docId} "${r.serviceName}": got ${r.currentSlug ?? "∅"} (correct: ${r.correctSlug})`).join("\n")}

## B1-forward by doc type
| doc type | recall | hits/denom |
|---|---|---|
${recallRows(s.b1Forward.byDocType)}

## B1-forward by insurer
| insurer | recall | hits/denom |
|---|---|---|
${recallRows(s.b1Forward.byInsurer)}

## G-junk-4 over-collapse (vs baseline B5)
${s.overCollapse.length === 0 ? "_none flagged_" : s.overCollapse.map((o) => `  - ${o.slug}: ${o.baseline} → ${o.current} (${o.deltaPct < 0 ? "new" : (o.deltaPct * 100).toFixed(0) + "%"})`).join("\n")}
`;
}

function convergenceMd(c: ConvergenceReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const hist = (h: Record<number, number>) =>
    Object.keys(h).map(Number).sort((a, b) => b - a).map((k) => `${k}/${c.nRuns}:${h[k]}`).join(" · ");
  return `

## N-run majority convergence (N=${c.nRuns}) — gate stability
| scope | mean agreement | unstable (<unanimous) | fragile (margin≤1) |
|---|---|---|---|
| all scored | ${pct(c.meanAgreementAll)} | ${c.unstableAll} | ${c.fragileAll} |
| **andrew (B2 subset)** | **${pct(c.meanAgreementAndrew)}** | ${c.unstableAndrew} | **${c.fragileAndrew}** |

tie-broken (count-tie → confidence/lex): ${c.tieBroken} · agreement histogram (andrew): ${hist(c.histogramAndrew)}
${c.fragileAndrew > 0 ? `\n### fragile andrew entries (one flipped vote changes the answer)\n${c.fragileAndrewSample.map((s) => `  - "${s.serviceName}" → ${s.winner ?? "∅"}  votes: ${JSON.stringify(s.votes)}`).join("\n")}` : "_no fragile andrew entries — the B2 gate is stable_"}
`;
}

async function main() {
  const dir = resolve(process.argv[2] ?? "./calibration-out");
  const baselineForwardPath = process.argv[3];
  const { gt, warnings } = loadGt(join(dir, "gt.json"));
  if (warnings.length) console.warn(`GT warnings:\n  ${warnings.join("\n  ")}`);
  const forward = readJson<ForwardMapEntry[]>(join(dir, "forward.json"));
  const stored = readJson<StoredCanonical[]>(join(dir, "stored.json"));
  const cohorts = readJson<CohortSnapshot[]>(join(dir, "cohorts-snapshot.json"));
  const baselineB5 = readJson<B5Counts>(join(dir, "b5-baseline.json"));
  const currentB5 = readJson<B5Counts>(join(dir, "b5-current.json"));
  const baselineForward = baselineForwardPath ? readJson<ForwardMapEntry[]>(baselineForwardPath) : undefined;
  // S168: rename map (emitted by resolve-snapshot from merged_into_id) + the frozen OLD catalog slug
  // set (catalog.json, pre-148) — drives canon() + the New-vocab/News bucket.
  const renameMap = existsSync(join(dir, "rename-map.json")) ? readJson<Record<string, string>>(join(dir, "rename-map.json")) : {};
  const oldSlugs = existsSync(join(dir, "catalog.json"))
    ? new Set(readJson<{ slug: string }[]>(join(dir, "catalog.json")).map((c) => c.slug))
    : new Set<string>();
  if (!Object.keys(renameMap).length) console.warn("⚠ rename-map.json missing/empty — renames may read as regressions.");
  if (!oldSlugs.size) console.warn("⚠ catalog.json (old slug set) missing — News bucket cannot be computed.");

  const card = buildScoreCard({
    phaseLabel: process.env.PHASE_LABEL ?? "baseline",
    gtVersion: process.env.GT_VERSION ?? "v1",
    gt, forward, baselineForward, stored, cohorts, baselineB5, currentB5, renameMap, oldSlugs,
  });

  // S170 hardening B: stamp the scorecard INVALID on a degenerate run (collapsed denominator). The card is
  // still written (for the record + the loud banner), but we exit nonzero below BEFORE any gate enforcement
  // can read a fake precision number off the easy hits.
  const validity = validateSnapshot(card, gt);
  if (!validity.valid) card.invalid = { reason: validity.reason as string };

  // S170: convergence summary (written by the N-run producer) — the gate's stability statement.
  const convergence = existsSync(join(dir, "convergence.json")) ? readJson<ConvergenceReport>(join(dir, "convergence.json")) : null;
  const md = scorecardMd(card) + (convergence ? convergenceMd(convergence) : "");
  writeFileSync(join(dir, "scorecard.json"), JSON.stringify(card, null, 2));
  writeFileSync(join(dir, "scorecard.md"), md);
  console.log(md);
  console.log(`\nwrote ${join(dir, "scorecard.json")} + scorecard.md`);

  // S170 hardening B: a degenerate run never reaches the ledger/gate — exit nonzero (distinct code 2 vs the
  // gate's 3) so a collapsed-denominator run can never be mistaken for a pass.
  if (card.invalid) {
    console.error(`\n⛔ SCORECARD INVALID — ${card.invalid.reason}`);
    console.error("Refusing to report ledger/gate from a degenerate run. Exit 2.");
    process.exit(2);
  }

  // S168 REFRAME (§7.6): the before/after ledger compares two stochastic Haiku runs (noise-confounded)
  // → DIAGNOSTIC only, NOT the hard gate. Report regressions; never exit-fail on them.
  if (card.ledger.counts.regressions > 0)
    console.warn(`\n⚠ ${card.ledger.counts.regressions} ledger regression(s) — DIAGNOSTIC only (§7.6 reframe; the gate is B2-vs-oracle + N-run majority, not the two-run ledger).`);

  // The hard gate (§7.6) — enforced only when thresholds are passed in. Step 6 sets GATE_B2/GATE_B1;
  // Step 4 runs report-only (no GATE env).
  const gateB2 = process.env.GATE_B2 ? Number(process.env.GATE_B2) : null;
  const gateB1 = process.env.GATE_B1 ? Number(process.env.GATE_B1) : null;
  if (gateB2 !== null || gateB1 !== null) {
    const b2 = card.b2Precision.precision, b1 = card.b1Forward.recall;
    const b2ok = gateB2 === null || b2 >= gateB2;
    const b1ok = gateB1 === null || b1 >= gateB1;
    // S170 hardening B — gate-DISPLAY honesty: print the raw integer counts the decision is made on, not a
    // rounded %. 2203/2272 = 96.96% renders as "97.0%" at 1-decimal and masks a miss; the decision uses the
    // exact float (b1 >= gateB1) — show the integers + the integer threshold so the % can never mislead again.
    const { correct, mappedAndrew } = card.b2Precision;
    const { hits, denom } = card.b1Forward;
    const b2Need = gateB2 !== null ? Math.ceil(gateB2 * mappedAndrew) : null;
    const b1Need = gateB1 !== null ? Math.ceil(gateB1 * denom) : null;
    console.log("\nGATE (decision is on exact counts, not the rounded %):");
    console.log(`  B2 precision: ${correct}/${mappedAndrew} = ${(b2 * 100).toFixed(2)}%${gateB2 !== null ? ` · need ≥${(gateB2 * 100).toFixed(1)}% → ≥${b2Need}/${mappedAndrew} · ${b2ok ? "✓" : "✗"}` : ""}`);
    console.log(`  B1 recall:    ${hits}/${denom} = ${(b1 * 100).toFixed(2)}%${gateB1 !== null ? ` · need ≥${(gateB1 * 100).toFixed(1)}% → ≥${b1Need}/${denom} · ${b1ok ? "✓" : "✗"}` : ""}`);
    if (!b2ok || !b1ok) { console.error("✗ GATE NOT MET"); process.exit(3); }
    console.log("✓ GATE MET");
  }
}
main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
