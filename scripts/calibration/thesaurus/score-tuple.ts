/**
 * Service Thesaurus harness — TUPLE scorer (A2b Phase 2). SEPARATE from score.ts (the untouched,
 * A1-comparable slug-level scorer). Pure functions over frozen GT + forward + decode-map. Scores the
 * Pattern-S modifier dimensions ADDITIVELY on the tuple-bearing GT subset.
 *
 * What it measures (S226 honest framing):
 *  - full-tuple match (slug ∧ place ∧ component) on single-tuple rows — the headline.
 *  - exact-set match on the inpatient physician/surgeon umbrella — measures MIXED DETECTION
 *    (NON-circular: deriveModifiers can under/over-fire).
 *  - "modifiers-correct | slug-correct" — isolates modifier quality from slug quality.
 *  - place/component on the cluster — a deterministic REGRESSION GUARD on deriveModifiers + a
 *    phrasing-robustness check on the real varied corpus (the decode TRUTH is self-designed → not a
 *    discovery metric; reported as a guard, not a headline).
 *
 * GT tuple-truth = row.multiLabel ?? decode-map[correctSlug]  (RAW correctSlug — the decode-map is keyed
 * by the granular slug, which is exactly what correctSlug holds; canon'ing it would miss every clean row).
 * Slug comparison is canon-aware (rename-map); slug-level B1/B2 stay in score.ts.
 */
import type { GtService, ForwardMapEntry, ModifierTuple } from "./types";

export interface DecodeEntry { slug: string; placeOfService: string; component: "facility" | "professional" | "global"; }
export type DecodeMap = Record<string, DecodeEntry>;

/** The cluster this LEAD targets (surgeon/hospital facility-professional split + transplant + its travel). */
const CLUSTER_SLUGS = new Set(["hospital_admission", "surgery", "transplant", "medical_travel"]);

interface Tup { slug: string; place: string; component: string; }
const key = (t: Tup) => `${t.slug}|${t.place}|${t.component}`;
const setKey = (ts: Tup[]) => ts.map(key).sort().join(" + ");

export interface TupleBucket {
  singleTotal: number; fullMatch: number; componentMatch: number; placeMatch: number;
  slugCorrect: number; modifierCorrectGivenSlug: number;
  multiTotal: number; setMatch: number;
}
export interface TupleScoreCard {
  all: TupleBucket; andrew: TupleBucket; cluster: TupleBucket; clusterAndrew: TupleBucket;
  misses: { gtId: string; serviceName: string; insurer: string; multi: boolean; gt: string; got: string }[];
  /** item 6 — is_preventive_eligible: recall on GT-true rows (a guard; the cue is shared) + corpus-wide
   *  over-fire (the NON-circular signal: did the flag fire where the GT says it shouldn't?). */
  preventive: { gtTrue: number; recall: number; overFire: number; overFireRows: { gtId: string; serviceName: string; slug: string }[] };
}

const emptyBucket = (): TupleBucket => ({
  singleTotal: 0, fullMatch: 0, componentMatch: 0, placeMatch: 0, slugCorrect: 0, modifierCorrectGivenSlug: 0, multiTotal: 0, setMatch: 0,
});

export function buildTupleScoreCard(args: {
  gt: GtService[]; forward: ForwardMapEntry[]; decodeMap: DecodeMap; renameMap?: Record<string, string>;
}): TupleScoreCard {
  const { gt, forward, decodeMap } = args;
  const rename = args.renameMap ?? {};
  const canon = (s: string | null | undefined): string => (s == null ? "∅" : (rename[s] ?? s));
  const fwd = new Map(forward.map((f) => [f.gtId, f]));
  const toTup = (m: ModifierTuple): Tup => ({ slug: canon(m.slug), place: m.placeOfService, component: m.component });

  const gtTuples = (g: GtService): Tup[] | null => {
    if (g.multiLabel?.length) return g.multiLabel.map(toTup);
    const d = decodeMap[g.correctSlug ?? ""]; // RAW correctSlug (granular key) — NOT canon'd
    return d ? [{ slug: canon(d.slug), place: d.placeOfService, component: d.component }] : null;
  };
  const resolverTuples = (f: ForwardMapEntry | undefined): Tup[] => {
    if (f?.multiLabel?.length) return f.multiLabel.map(toTup);
    return [{ slug: canon(f?.resolvedSlug), place: f?.placeOfService ?? "∅", component: f?.component ?? "∅" }];
  };

  const card: TupleScoreCard = { all: emptyBucket(), andrew: emptyBucket(), cluster: emptyBucket(), clusterAndrew: emptyBucket(), misses: [], preventive: { gtTrue: 0, recall: 0, overFire: 0, overFireRows: [] } };
  const target = (g: GtService, inCluster: boolean): TupleBucket[] => {
    const bs = [card.all];
    const a = g.adjudicationStatus === "andrew";
    if (a) bs.push(card.andrew);
    if (inCluster) { bs.push(card.cluster); if (a) bs.push(card.clusterAndrew); }
    return bs;
  };

  for (const g of gt) {
    if (g.notFound) continue;
    const truth = gtTuples(g);
    if (!truth) continue; // not tuple-bearing (base slug with no encoding — office visits, drugs, …)
    const got = resolverTuples(fwd.get(g.id));
    const inCluster = truth.some((t) => CLUSTER_SLUGS.has(t.slug));
    const bs = target(g, inCluster);

    if (truth.length > 1) {
      const ok = setKey(truth) === setKey(got);
      for (const b of bs) { b.multiTotal += 1; if (ok) b.setMatch += 1; }
      if (!ok) card.misses.push({ gtId: g.id, serviceName: g.serviceName, insurer: g.insurer, multi: true, gt: setKey(truth), got: setKey(got) });
    } else {
      const T = truth[0];
      const overEmit = got.length > 1; // resolver emitted a SET on a single-truth row → over-detection (miss)
      const G = got[0] ?? { slug: "∅", place: "∅", component: "∅" };
      const slugOk = !overEmit && T.slug === G.slug;
      const placeOk = !overEmit && T.place === G.place;
      const compOk = !overEmit && T.component === G.component;
      const fullOk = slugOk && placeOk && compOk;
      for (const b of bs) {
        b.singleTotal += 1;
        if (fullOk) b.fullMatch += 1;
        if (compOk) b.componentMatch += 1;
        if (placeOk) b.placeMatch += 1;
        if (slugOk) { b.slugCorrect += 1; if (placeOk && compOk) b.modifierCorrectGivenSlug += 1; }
      }
      if (!fullOk) card.misses.push({ gtId: g.id, serviceName: g.serviceName, insurer: g.insurer, multi: false, gt: key(T), got: overEmit ? setKey(got) : key(G) });
    }
  }
  // item 6 — preventive-eligible flag (over ALL rows, not just the tuple cluster): recall on GT-true + over-fire.
  for (const g of gt) {
    if (g.notFound) continue;
    const f = fwd.get(g.id);
    const gtFlag = g.isPreventiveEligible === true;
    const resFlag = f?.isPreventiveEligible === true;
    if (gtFlag) { card.preventive.gtTrue += 1; if (resFlag) card.preventive.recall += 1; }
    if (resFlag && !gtFlag) {
      card.preventive.overFire += 1;
      if (card.preventive.overFireRows.length < 10) card.preventive.overFireRows.push({ gtId: g.id, serviceName: g.serviceName, slug: f?.resolvedSlug ?? "∅" });
    }
  }
  return card;
}

export function tupleScoreCardMd(c: TupleScoreCard): string {
  const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}% (${n}/${d})` : "—");
  const row = (label: string, b: TupleBucket) =>
    `| ${label} | ${pct(b.fullMatch, b.singleTotal)} | ${pct(b.componentMatch, b.singleTotal)} | ${pct(b.placeMatch, b.singleTotal)} | ${pct(b.modifierCorrectGivenSlug, b.slugCorrect)} | ${pct(b.setMatch, b.multiTotal)} |`;
  return `## Tuple scorecard (A2b Phase 2 — ADDITIVE; slug-level B1/B2 unchanged in score.ts)

| subset | full-tuple | component | place | modifiers · given-slug | umbrella set-match |
|---|---|---|---|---|---|
${row("all tuple-bearing", c.all)}
${row("andrew", c.andrew)}
${row("surgeon/hosp/transplant cluster", c.cluster)}
${row("cluster · andrew", c.clusterAndrew)}

> Non-circular signals: umbrella **set-match** (mixed detection) + slug B1/B2 (score.ts) + dropped-themes.
> place/component = deterministic regression-guard on deriveModifiers + phrasing-robustness on the real corpus.

**is_preventive_eligible (item 6):** recall ${c.preventive.recall}/${c.preventive.gtTrue} on GT-flagged rows (guard — cue shared with GT) · **over-fire ${c.preventive.overFire}** (NON-circular: flag fired where GT says not)${c.preventive.overFireRows.length ? " → " + c.preventive.overFireRows.map((r) => `${r.slug}:"${r.serviceName.slice(0, 32)}"`).join("; ") : ""}

### tuple misses (first 25)
${c.misses.slice(0, 25).map((m) => `  - ${m.insurer} "${m.serviceName}"${m.multi ? " [multi]" : ""}: got \`${m.got}\` · want \`${m.gt}\``).join("\n") || "  _none_"}
`;
}
