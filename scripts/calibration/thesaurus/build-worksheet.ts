/**
 * Deterministic adjudication-worksheet builder (no DB, no Haiku).
 *
 * Refined S162: the worksheet is the FOCUSED set Andrew rules on —
 *   - TRICKY clusters: entries with trickyReason "multi_slug" or "no_concept",
 *     grouped by (reason × proposed slug) so one RULING covers the whole pattern
 *     (its member ids ride a single `ids` cell; apply-adjudications expands them).
 *   - RANDOM sample (~200): individual scored+mapped entries (deterministic), the
 *     UNBIASED basis for B2 precision.
 * The same-doc-same-slug "negative pair" signal is NOT adjudication-required (coarse-
 * catalog noise + redundant with multi_slug/B2); it is written to neg-pair-clusters.json
 * as an INFORMATIONAL view only. The true co-occurrence veto is a Phase-2 mechanism.
 *
 * Run: npx tsx scripts/calibration/thesaurus/build-worksheet.ts <gt.json> <out-dir> [randomN=200]
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { GtService } from "./types";

const SEP = "::";

/** Deterministic 32-bit string hash (stable random ordering without Math.random). */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const clean = (s: string) => s.replace(/[\t\n\r]/g, " ").slice(0, 80);

function main() {
  const [gtPath, outDir, randomNArg] = process.argv.slice(2);
  if (!gtPath || !outDir) throw new Error("usage: build-worksheet.ts <gt.json> <out-dir> [randomN]");
  const randomN = Number(randomNArg ?? 200);
  const gt: GtService[] = JSON.parse(readFileSync(gtPath, "utf8"));
  // Exclude entries already adjudicated by Andrew — so a re-generated sheet only shows REMAINING work.
  const scored = gt.filter((g) => !g.notFound && g.adjudicationStatus !== "andrew");

  // ── TRICKY clusters ──
  //   multi_slug → grouped by the proposed best slug (one ruling per ambiguous pattern).
  //   no_concept → grouped by NORMALIZED SERVICE NAME (the same unmapped service across docs
  //                rules together: "add a concept", map to an existing slug, or DROP).
  const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const tricky = scored.filter((g) => g.trickyReason === "multi_slug" || g.trickyReason === "no_concept" || g.correctSlug === null);
  const clusters = new Map<string, GtService[]>();
  for (const g of tricky) {
    const isNoConcept = g.correctSlug === null;
    const reason = isNoConcept ? "no_concept" : (g.trickyReason ?? "multi_slug");
    const key = isNoConcept ? reason + SEP + normName(g.serviceName) : reason + SEP + (g.correctSlug ?? "NO_CONCEPT");
    const arr = clusters.get(key) ?? [];
    arr.push(g);
    clusters.set(key, arr);
  }
  const allClusters = [...clusters.entries()].map(([key, members]) => {
    const reason = key.split(SEP)[0];
    return { reason, isNC: reason === "no_concept", members,
      alts: [...new Set(members.flatMap((m) => m.proposedAlternatives ?? []))].join("|") };
  });
  // no_concept SINGLETONS → deferred to the §8 Phase-4 new-concept candidate file (inert until
  // ruled; not Phase-0 adjudication). Recurring no_concept (>=2) + ALL multi_slug stay on the sheet.
  const ncSingletons = allClusters.filter((c) => c.isNC && c.members.length === 1);
  const clusterRows = allClusters
    .filter((c) => !(c.isNC && c.members.length === 1))
    .map((c) => ({
      ids: c.members.map((m) => m.id).join(";"),
      kind: "cluster",
      reason: c.reason,
      proposed_slug: c.isNC ? "NO_CONCEPT" : (c.members[0].correctSlug as string),
      alternatives: c.alts,
      member_count: c.members.length,
      example: clean(c.members[0].serviceName),
    }))
    .sort((a, b) => b.member_count - a.member_count);

  // ── RANDOM ~N: unbiased B2 basis — individual scored+mapped entries, deterministic order ──
  const mapped = scored.filter((g) => g.correctSlug !== null);
  const randomRows = [...mapped]
    .sort((a, b) => hash(a.id) - hash(b.id))
    .slice(0, Math.min(randomN, mapped.length))
    .map((g) => ({
      ids: g.id, kind: "random", reason: "random_sample", proposed_slug: g.correctSlug as string,
      alternatives: (g.proposedAlternatives ?? []).join("|"), member_count: 1, example: clean(g.serviceName),
    }));

  // RULING + readable columns first; the long semicolon-joined `ids` cell goes LAST (out of the way;
  // apply-adjudications.ts finds columns by header name, so order is irrelevant to the merge).
  const header = "kind\treason\tproposed_slug\talternatives\tmember_count\texample\tRULING\tids";
  const body = [...clusterRows, ...randomRows].map(
    (r) => `${r.kind}\t${r.reason}\t${r.proposed_slug}\t${r.alternatives}\t${r.member_count}\t${r.example}\t\t${r.ids}`,
  );
  writeFileSync(join(outDir, "adjudication-worksheet.tsv"), [header, ...body].join("\n") + "\n");

  // ── informational neg-pair clusters (NOT adjudication-required) ──
  const negPairs = scored.filter((g) => g.isNegativePair);
  const negClusters = new Map<string, string[]>();
  for (const g of negPairs) {
    const k = g.docId + SEP + (g.correctSlug ?? "NO_CONCEPT");
    const arr = negClusters.get(k) ?? [];
    arr.push(g.id);
    negClusters.set(k, arr);
  }
  writeFileSync(join(outDir, "neg-pair-clusters.json"), JSON.stringify(
    {
      note: "INFORMATIONAL ONLY — coarse-catalog same-doc-same-slug groupings; NOT adjudication-required. True co-occurrence veto deferred to Phase 2.",
      clusters: [...negClusters.entries()].map(([k, ids]) => ({ key: k.split(SEP).join(" · "), ids })),
    },
    null, 2,
  ));

  // ── no_concept singletons → Phase-4 new-concept candidates (NOT Phase-0 adjudication) ──
  writeFileSync(join(outDir, "new-concept-candidates.json"), JSON.stringify(
    {
      note: "no_concept SINGLETONS (one occurrence in the corpus) — §8 Phase-4 new-concept candidates, NOT Phase-0 adjudication-required. Inert until ruled (correctSlug stays null → excluded from B1/B2). Review when expanding the catalog past 69 concepts.",
      candidates: ncSingletons.map((c) => ({ id: c.members[0].id, serviceName: c.members[0].serviceName, docId: c.members[0].docId })),
    },
    null, 2,
  ));

  const onSheet = clusterRows.reduce((n, r) => n + r.member_count, 0);
  console.log(`worksheet: ${clusterRows.length} clusters (covering ${onSheet} entries) + ${randomRows.length} random = ${clusterRows.length + randomRows.length} RULINGS for Andrew`);
  console.log(`  new-concept-candidates.json: ${ncSingletons.length} no_concept singletons DEFERRED to Phase 4 (not adjudication-required)`);
  console.log(`  neg-pair-clusters.json: ${negClusters.size} informational clusters (${negPairs.length} entries) — NOT adjudication-required`);
}
main();
