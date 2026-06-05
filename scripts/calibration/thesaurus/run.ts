/**
 * Service Thesaurus harness — DETERMINISTIC scoring run (no DB, no Haiku).
 * Reads frozen GT + frozen snapshots (produced by resolve-snapshot.ts, the Sonnet step)
 * → buildScoreCard → writes scorecard JSON + markdown to the output dir.
 *
 * Run: npx tsx scripts/calibration/thesaurus/run.ts <snapshot-dir> [baseline-forward.json]
 *   <snapshot-dir> contains: gt.json, forward.json, stored.json, cohorts-snapshot.json, b5-baseline.json, b5-current.json
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import { buildScoreCard } from "./score";
import { loadGt } from "./gt-loader";
import type { ForwardMapEntry, StoredCanonical, CohortSnapshot, B5Counts, ScoreCard } from "./types";

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

function scorecardMd(s: ScoreCard): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const recallRows = (m: Record<string, { recall: number; hits: number; denom: number }>) =>
    Object.entries(m).map(([k, v]) => `| ${k} | ${pct(v.recall)} | ${v.hits}/${v.denom} |`).join("\n");
  return `# Thesaurus scorecard — ${s.phaseLabel}

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

  writeFileSync(join(dir, "scorecard.json"), JSON.stringify(card, null, 2));
  writeFileSync(join(dir, "scorecard.md"), scorecardMd(card));
  console.log(scorecardMd(card));
  console.log(`\nwrote ${join(dir, "scorecard.json")} + scorecard.md`);
  if (card.ledger.counts.regressions > 0) {
    console.error(`\n✗ ${card.ledger.counts.regressions} REGRESSION(S) — phase does not ship (§7 S3 zero-regression).`);
    process.exit(2);
  }
}
main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
