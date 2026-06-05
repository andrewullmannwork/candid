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
  /** S168: deprecated-slug -> live-target map (from merged_into_id), so renames don't read as regressions. */
  renameMap?: Record<string, string>;
  /** S168: pre-148 catalog slug set (frozen catalog.json) — identifies NEW-VOCAB slugs for the News bucket. */
  oldSlugs?: Set<string>;
}): ScoreCard {
  const { phaseLabel, gtVersion, gt, forward, stored, cohorts, baselineB5, currentB5 } = args;
  const fwd = new Map(forward.map((f) => [f.gtId, f]));
  const storedBy = new Map(stored.map((s) => [s.canonicalPlanId, new Set(s.slugs)]));

  // ── S168 rename-awareness: canonicalize OLD oracle slugs to the NEW vocabulary before comparing.
  // The merge pattern (merged_into_id) is the authoritative identity link: generic_rx_tier1 and
  // generic_rx ARE the same service identity, so scoring them equal reflects ground truth (NOT a hack).
  const renameMap = args.renameMap ?? {};
  const oldSlugs = args.oldSlugs ?? new Set<string>();
  const canon = (s: string | null): string | null => (s == null ? null : (renameMap[s] ?? s));
  // NEW-VOCAB = a post-148 slug that is NOT the rename target of any OLD slug. Rename targets
  // (generic_rx <- generic_rx_tier1) are renames of EXISTING concepts, not new vocabulary; genuinely
  // new slugs (dialysis, abortion, covid_test) have no OLD slug that canon()s to them. This is what
  // separates "News mapped to a brand-new slug" (the semi-circular bucket) from a plain rename.
  const renameTargetsOfOld = new Set<string>();
  for (const s of oldSlugs) { const t = renameMap[s]; if (t) renameTargetsOfOld.add(t); }
  const isNewVocab = (s: string | null): boolean => s != null && !oldSlugs.has(s) && !renameTargetsOfOld.has(s);

  // ── S169 acceptable-alternatives: a genuinely ambiguous service scores correct on correctSlug OR any
  // human-adjudicated acceptableSlug (rename-aware). Single-answer exact-match can't grade legit ambiguity
  // (e.g. an eye-specialist visit is correct as specialist_visit OR medical_eye_care).
  const okSlug = (canonR: string | null, g: GtService): boolean =>
    canonR === canon(g.correctSlug) || (g.acceptableSlugs ?? []).some((a) => canonR === canon(a));

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
  let correct = 0, mappedAndrew = 0, fp = 0, fpNewVocab = 0, noConceptAndrew = 0;
  const p2Doc: Record<string, { precision: number; correct: number; mapped: number }> = {};
  const p2Ins: Record<string, { precision: number; correct: number; mapped: number }> = {};
  const pbump = (m: typeof p2Doc, k: string, ok: boolean) => {
    const c = m[k] ?? { precision: 0, correct: 0, mapped: 0 };
    c.mapped += 1; if (ok) c.correct += 1; c.precision = c.mapped ? c.correct / c.mapped : 0; m[k] = c;
  };
  for (const g of gt) {
    if (g.adjudicationStatus !== "andrew" || g.notFound) continue;
    const r = fwd.get(g.id)?.resolvedSlug ?? null;
    if (isNoConcept(g)) {
      noConceptAndrew += 1;
      // no-concept that now maps: NEW-VOCAB slug = intended News recovery (apart); else genuine over-mapping.
      if (r !== null) { if (isNewVocab(r)) fpNewVocab += 1; else fp += 1; }
      continue;
    }
    if (r === null) continue; // unmapped → not a precision sample (it's a recall miss)
    mappedAndrew += 1;
    const ok = okSlug(canon(r), g); // rename-aware + S169 acceptable-alternatives
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
    falsePositives: fp, falsePositivesNewVocab: fpNewVocab, noConceptAndrew,
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
      // S168: the GATE is the ANDREW ledger (independent, human-adjudicated). auto entries have
      // resolver-proposed correctSlugs (circular) → excluded. All three sides canon'd so a rename
      // (old oracle slug vs new resolved slug) collapses to identity instead of a false regression.
      if (!isScored(g) || g.adjudicationStatus !== "andrew") continue;
      const b = canon(base.get(g.id)?.resolvedSlug ?? null);
      const c = canon(fwd.get(g.id)?.resolvedSlug ?? null);
      const correctSlug = canon(g.correctSlug);
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

  // ── S168 after-score 3-way split (andrew-only, rename-aware) ──
  // (a) recovered  = the improvements ledger (before-wrong -> after-right; the structure fixed it).
  // (b) stillWrong = andrew-scored where the after-resolver is still wrong (Phase-2 synonym backlog).
  // (c) newsRecover = no-concept andrew entries the after-resolver now maps to a NEW-VOCAB slug.
  //     Reported APART: we minted those slugs from the same classification, so this is COVERAGE, not
  //     validated precision — the workbench's human spot-check is the non-circular precision oracle.
  const stillWrong: LedgerEntry[] = [];
  const newsBySlug: Record<string, { count: number; sampleNames: string[] }> = {};
  let newsCount = 0;
  for (const g of gt) {
    if (g.adjudicationStatus !== "andrew" || g.notFound) continue;
    const r = fwd.get(g.id)?.resolvedSlug ?? null;
    if (isScored(g)) {
      if (!okSlug(canon(r), g)) {
        stillWrong.push({ gtId: g.id, serviceName: g.serviceName, docId: g.docId, insurer: g.insurer, baselineSlug: null, currentSlug: canon(r), correctSlug: canon(g.correctSlug) });
      }
    } else if (isNoConcept(g) && isNewVocab(r)) {
      newsCount += 1;
      const slug = r as string;
      const e = newsBySlug[slug] ?? { count: 0, sampleNames: [] };
      e.count += 1;
      if (e.sampleNames.length < 5) e.sampleNames.push(g.serviceName);
      newsBySlug[slug] = e;
    }
  }
  const threeWay = {
    recovered: { count: ledger.improvements.length, sample: ledger.improvements.slice(0, 25) },
    stillWrong: { count: stillWrong.length, sample: stillWrong.slice(0, 25) },
    newsRecover: { count: newsCount, bySlug: newsBySlug },
  };

  return { phaseLabel, gtVersion, corpus, b1Forward, b1Stored, b2Precision, b3, ledger, overCollapse, threeWay };
}
