/**
 * Service Thesaurus harness — DETERMINISTIC scorer (no DB, no Haiku).
 * Pure functions over frozen GT + frozen snapshots. Unit-tested via fixture.ts.
 */
import type {
  GtService, ForwardMapEntry, StoredCanonical, CohortSnapshot, B5Counts,
  ScoreCard, RecallBreakdown, LedgerEntry,
} from "./types";

const rb = (hits: number, denom: number): RecallBreakdown => ({ recall: denom ? hits / denom : 0, hits, denom });

/** A GT entry that participates in recall/precision: a real correct slug, not a GT-fidelity miss. */
function isScored(g: GtService): boolean {
  return !g.notFound && g.correctSlug !== null;
}
function isNoConcept(g: GtService): boolean {
  return !g.notFound && g.correctSlug === null;
}

function bump(map: Record<string, RecallBreakdown>, key: string, hit: boolean) {
  const cur = map[key] ?? { recall: 0, hits: 0, denom: 0 };
  cur.denom += 1;
  if (hit) cur.hits += 1;
  cur.recall = cur.denom ? cur.hits / cur.denom : 0;
  map[key] = cur;
}

export function buildScoreCard(args: {
  phaseLabel: string;
  gtVersion: string;
  gt: GtService[];
  forward: ForwardMapEntry[];
  baselineForward?: ForwardMapEntry[]; // omit for the baseline run itself
  stored: StoredCanonical[];
  cohorts: CohortSnapshot[];
  baselineB5: B5Counts;
  currentB5: B5Counts;
  overCollapseDeltaPct?: number; // default 0.5
  overCollapseMinAbs?: number; // default 25
}): ScoreCard {
  const { phaseLabel, gtVersion, gt, forward, stored, cohorts, baselineB5, currentB5 } = args;
  const fwd = new Map(forward.map((f) => [f.gtId, f]));
  const storedBy = new Map(stored.map((s) => [s.canonicalPlanId, new Set(s.slugs)]));

  // ── corpus ──
  const corpus: ScoreCard["corpus"] = {
    totalGt: gt.length,
    scored: gt.filter(isScored).length,
    noConcept: gt.filter(isNoConcept).length,
    negativePairs: gt.filter((g) => g.isNegativePair).length,
    notFound: gt.filter((g) => g.notFound).length,
    andrewAdjudicated: gt.filter((g) => g.adjudicationStatus === "andrew").length,
    byDocType: {},
    byInsurer: {},
  };
  for (const g of gt) {
    corpus.byDocType[g.docType] = (corpus.byDocType[g.docType] ?? 0) + 1;
    corpus.byInsurer[g.insurer] = (corpus.byInsurer[g.insurer] ?? 0) + 1;
  }

  // ── B1-forward (resolver recall; moves every phase) ──
  let f1h = 0, f1d = 0;
  const f1Doc: Record<string, RecallBreakdown> = {};
  const f1Ins: Record<string, RecallBreakdown> = {};
  for (const g of gt) {
    if (!isScored(g)) continue;
    const hit = (fwd.get(g.id)?.resolvedSlug ?? null) !== null;
    f1d += 1; if (hit) f1h += 1;
    bump(f1Doc, g.docType, hit);
    bump(f1Ins, g.insurer, hit);
  }
  const b1Forward = { ...rb(f1h, f1d), byDocType: f1Doc, byInsurer: f1Ins };

  // ── B1-stored (current canonical coverage; moves at Phase-5 backfill) ──
  let s1h = 0, s1d = 0;
  for (const g of gt) {
    if (!isScored(g) || !g.canonicalPlanId) continue;
    s1d += 1;
    if (storedBy.get(g.canonicalPlanId)?.has(g.correctSlug as string)) s1h += 1;
  }
  const b1Stored = rb(s1h, s1d);

  // ── B2 precision (FLOOR; INDEPENDENT — andrew-adjudicated only) ──
  let correct = 0, mappedAndrew = 0, fp = 0, noConceptAndrew = 0;
  const p2Doc: Record<string, { precision: number; correct: number; mapped: number }> = {};
  const p2Ins: Record<string, { precision: number; correct: number; mapped: number }> = {};
  const pbump = (m: typeof p2Doc, k: string, ok: boolean) => {
    const c = m[k] ?? { precision: 0, correct: 0, mapped: 0 };
    c.mapped += 1; if (ok) c.correct += 1; c.precision = c.mapped ? c.correct / c.mapped : 0; m[k] = c;
  };
  for (const g of gt) {
    if (g.adjudicationStatus !== "andrew" || g.notFound) continue;
    const r = fwd.get(g.id)?.resolvedSlug ?? null;
    if (isNoConcept(g)) { noConceptAndrew += 1; if (r !== null) fp += 1; continue; }
    if (r === null) continue; // unmapped → not a precision sample (it's a recall miss)
    mappedAndrew += 1;
    const ok = r === g.correctSlug;
    if (ok) correct += 1;
    pbump(p2Doc, g.docType, ok);
    pbump(p2Ins, g.insurer, ok);
  }
  // negative-pair distinctness (co-occurrence veto)
  let negViol = 0;
  for (const g of gt) {
    if (!g.isNegativePair || !g.negativePartnerIds?.length) continue;
    const mine = fwd.get(g.id)?.resolvedSlug ?? null;
    if (mine === null) continue;
    if (g.negativePartnerIds.some((pid) => (fwd.get(pid)?.resolvedSlug ?? null) === mine)) negViol += 1;
  }
  const b2Precision = {
    precision: mappedAndrew ? correct / mappedAndrew : 0,
    correct, mappedAndrew,
    falsePositiveRate: noConceptAndrew ? fp / noConceptAndrew : 0,
    falsePositives: fp, noConceptAndrew,
    negativePairViolations: negViol,
    byDocType: p2Doc, byInsurer: p2Ins,
  };

  // ── B3 compare gap-rate (with / without backstop), over frozen cohorts ──
  let totalCells = 0, unkWithout = 0, unkWith = 0;
  const perCohort: ScoreCard["b3"]["perCohort"] = [];
  for (const c of cohorts) {
    const rows = new Set<string>();
    for (const p of c.plans) { p.coveredSlugs.forEach((s) => rows.add(s)); p.inferredSlugs.forEach((s) => rows.add(s)); }
    let cells = 0, uw = 0, uwi = 0;
    for (const row of rows) {
      for (const p of c.plans) {
        cells += 1;
        const covered = p.coveredSlugs.includes(row);
        const inferred = p.inferredSlugs.includes(row);
        if (!covered) uw += 1;
        if (!covered && !inferred) uwi += 1;
      }
    }
    totalCells += cells; unkWithout += uw; unkWith += uwi;
    perCohort.push({ cohortId: c.cohortId, cells, unkWithout: uw, unkWith: uwi });
  }
  const b3 = {
    gapRateWithoutBackstop: totalCells ? unkWithout / totalCells : 0,
    gapRateWithBackstop: totalCells ? unkWith / totalCells : 0,
    totalCells, unkWithout, unkWith, perCohort,
  };

  // ── S3 zero-regression ledger (vs baseline forward snapshot) ──
  const ledger: ScoreCard["ledger"] = {
    regressions: [], improvements: [], newlyMapped: [], lost: [],
    counts: { regressions: 0, improvements: 0, newlyMapped: 0, lost: 0 },
  };
  if (args.baselineForward) {
    const base = new Map(args.baselineForward.map((f) => [f.gtId, f]));
    for (const g of gt) {
      if (!isScored(g)) continue;
      const b = base.get(g.id)?.resolvedSlug ?? null;
      const c = fwd.get(g.id)?.resolvedSlug ?? null;
      const correctSlug = g.correctSlug;
      const e: LedgerEntry = { gtId: g.id, serviceName: g.serviceName, docId: g.docId, insurer: g.insurer, baselineSlug: b, currentSlug: c, correctSlug };
      if (b === correctSlug && c !== correctSlug) ledger.regressions.push(e);
      else if (b !== correctSlug && c === correctSlug) ledger.improvements.push(e);
      else if (b === null && c !== null) ledger.newlyMapped.push(e);
      else if (b !== null && c === null) ledger.lost.push(e);
    }
    ledger.counts = {
      regressions: ledger.regressions.length, improvements: ledger.improvements.length,
      newlyMapped: ledger.newlyMapped.length, lost: ledger.lost.length,
    };
  }

  // ── G-junk-4 over-collapse (current B5 vs baseline B5) ──
  const deltaPct = args.overCollapseDeltaPct ?? 0.5;
  const minAbs = args.overCollapseMinAbs ?? 25;
  const overCollapse: ScoreCard["overCollapse"] = [];
  for (const slug of new Set([...Object.keys(baselineB5), ...Object.keys(currentB5)])) {
    const base = baselineB5[slug] ?? 0;
    const cur = currentB5[slug] ?? 0;
    const growth = cur - base;
    const pct = base > 0 ? growth / base : cur > 0 ? Infinity : 0;
    if (growth >= minAbs && pct > deltaPct) overCollapse.push({ slug, baseline: base, current: cur, deltaPct: pct === Infinity ? -1 : pct });
  }
  overCollapse.sort((a, b) => b.current - a.current);

  return { phaseLabel, gtVersion, corpus, b1Forward, b1Stored, b2Precision, b3, ledger, overCollapse };
}
