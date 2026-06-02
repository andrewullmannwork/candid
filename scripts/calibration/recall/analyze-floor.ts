/**
 * Comprehensive-extraction RECALL baseline — structural floor analyzer (S155).
 *
 * ZERO API SPEND. Answers: of the ground-truth services in each plan document,
 * how many fall INSIDE the single `services_cost_sharing` slice that today's
 * Mode-A path actually sends to Haiku, vs. in the EOC body Mode-A discards?
 *
 * This is the structural CEILING on Mode-A recall: Mode-A cannot extract a
 * service whose binding language never reaches the services prompt. Mode-B
 * (full-body sweep) must beat this. It is the meet-or-beat floor for the
 * comprehensive_extraction.md §7 Ship Gate (G2).
 *
 * Faithfulness: replicates PROD dispatch (`parser.ts` →
 * `pickFirstRange(sectionRanges, "services_cost_sharing")`) by importing the
 * real `segmentPlanDocSections`. KNOWN APPROXIMATION: PROD segments
 * `cleanupBoilerplate(ocr)`; this segments raw OCR. The headline gap (deep EOC
 * narrative outside the first services slice) is robust to boilerplate cleanup;
 * documented for Ship Gate honesty. Refine with cleanup if numbers are borderline.
 *
 * GT source: per-doc `<slug>.gt-candidate.json` (subagent full-body extraction,
 * Andrew-adjudicated). Inputs read from the LOCAL corpus folder (OCR + GT stay
 * local; only this scorecard + results JSON go to the vault).
 *
 * Usage: npx tsx scripts/calibration/recall/analyze-floor.ts
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { resolve } from 'path';
import {
  segmentPlanDocSections,
  countPriorityPlanDocSections,
} from '../../../src/lib/plan_doc/section-discovery';

const CORPUS_DIR = '/Users/andrewullmann/Desktop/candid-extraction-corpus';
const OUT_DIR =
  '/Users/andrewullmann/Desktop/du_weldenvarden/04_Professional/Airgetlam Labs LLC/Candid/plans/findings/extraction-recall-2026-06-02';
// GT JSON lands in the vault (subagent sandbox can write here; the local corpus dir is read-only to them).
const GT_DIR = resolve(OUT_DIR, 'gt');

interface GtService {
  service_name?: string;
  in_network_cost_share?: string | null;
  out_of_network_cost_share?: string | null;
  binding_excerpt?: string | null;
  source?: string | null;
  approx_location?: string | null;
  billing_codes?: string[];
}
interface GtDoc {
  doc_identity?: Record<string, unknown>;
  services?: GtService[];
}

/** Build a whitespace-flexible, anchored regex from a verbatim excerpt. */
function excerptRegex(excerpt: string): RegExp | null {
  const trimmed = excerpt.trim();
  if (trimmed.length < 8) return null; // too short to localize reliably
  // Escape regex specials, then collapse any run of whitespace to \s+ so that
  // pdftotext column spacing / Read-tool reflow differences don't cause misses.
  const escaped = trimmed
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  try {
    return new RegExp(escaped, 'i');
  } catch {
    return null;
  }
}

/** First char offset of the excerpt in the OCR (whitespace-flexible), or -1. */
function findOffset(ocr: string, excerpt: string): number {
  // Fast path: exact substring.
  const exact = ocr.indexOf(excerpt.trim());
  if (exact >= 0) return exact;
  const re = excerptRegex(excerpt);
  if (!re) return -1;
  const m = re.exec(ocr);
  return m ? m.index : -1;
}

interface DocResult {
  slug: string;
  identity: Record<string, unknown>;
  ocr_chars: number;
  priority_sections: number;
  fallback_would_fire: boolean; // PROD Haiku-discovery fires when regexCount < 2
  services_slice: { start: number; end: number; len: number; pct_of_doc: number } | null;
  gt_total: number;
  found: number;
  not_found: number; // excerpt not locatable in OCR — GT fidelity flag
  in_slice: number; // Mode-A CAN see (structural ceiling numerator)
  out_of_slice: number; // Mode-A structurally MISSES
  narrative_only_flagged: number; // GT self-reported source === 'detailed_narrative'
  structural_ceiling_pct: number | null; // in_slice / (in_slice+out_of_slice)
  out_of_slice_examples: string[];
}

function analyzeDoc(slug: string): DocResult | null {
  const ocrPath = `${CORPUS_DIR}/${slug}.ocr.txt`;
  const gtPath = `${GT_DIR}/${slug}.gt-candidate.json`;
  if (!existsSync(ocrPath) || !existsSync(gtPath)) return null;

  const ocr = readFileSync(ocrPath, 'utf-8');
  let gt: GtDoc;
  try {
    gt = JSON.parse(readFileSync(gtPath, 'utf-8')) as GtDoc;
  } catch (err) {
    console.warn(`  [${slug}] GT JSON parse failed: ${(err as Error).message}`);
    return null;
  }
  const services = Array.isArray(gt.services) ? gt.services : [];

  const ranges = segmentPlanDocSections(ocr);
  const priority = countPriorityPlanDocSections(ranges);
  const svcRanges = ranges['services_cost_sharing'] ?? [];
  const slice = svcRanges[0] ?? null; // PROD pickFirstRange == [0]

  let found = 0;
  let notFound = 0;
  let inSlice = 0;
  let outSlice = 0;
  let narrativeOnly = 0;
  const outExamples: string[] = [];

  for (const s of services) {
    if (s.source === 'detailed_narrative') narrativeOnly += 1;
    const ex = s.binding_excerpt;
    if (!ex || ex.trim().length < 8) {
      notFound += 1;
      continue;
    }
    const off = findOffset(ocr, ex);
    if (off < 0) {
      notFound += 1;
      continue;
    }
    found += 1;
    if (slice && off >= slice.start && off < slice.end) {
      inSlice += 1;
    } else {
      outSlice += 1;
      if (outExamples.length < 8) outExamples.push((s.service_name ?? '?').slice(0, 60));
    }
  }

  const denom = inSlice + outSlice;
  return {
    slug,
    identity: gt.doc_identity ?? {},
    ocr_chars: ocr.length,
    priority_sections: priority,
    fallback_would_fire: priority < 2,
    services_slice: slice
      ? {
          start: slice.start,
          end: slice.end,
          len: slice.end - slice.start,
          pct_of_doc: +(((slice.end - slice.start) / ocr.length) * 100).toFixed(1),
        }
      : null,
    gt_total: services.length,
    found,
    not_found: notFound,
    in_slice: inSlice,
    out_of_slice: outSlice,
    narrative_only_flagged: narrativeOnly,
    structural_ceiling_pct: denom > 0 ? +((inSlice / denom) * 100).toFixed(1) : null,
    out_of_slice_examples: outExamples,
  };
}

function main(): void {
  if (!existsSync(GT_DIR)) {
    console.log(`No GT dir yet at ${GT_DIR}. Waiting on GT subagents.`);
    return;
  }
  const slugs = readdirSync(GT_DIR)
    .filter((f) => f.endsWith('.gt-candidate.json'))
    .map((f) => f.replace('.gt-candidate.json', ''))
    .sort();

  if (slugs.length === 0) {
    console.log(`No *.gt-candidate.json found in ${GT_DIR} yet. Waiting on GT subagents.`);
    return;
  }

  console.log(`=== Comprehensive-extraction RECALL — structural floor (${slugs.length} docs) ===\n`);
  const results: DocResult[] = [];
  for (const slug of slugs) {
    const r = analyzeDoc(slug);
    if (!r) {
      console.log(`  [${slug}] skipped (missing OCR/GT or parse error)`);
      continue;
    }
    results.push(r);
    const sl = r.services_slice;
    console.log(
      `  ${slug}: GT=${r.gt_total} found=${r.found} notFound=${r.not_found} | ` +
        `in-slice=${r.in_slice} out-of-slice=${r.out_of_slice} | ` +
        `ceiling=${r.structural_ceiling_pct ?? 'n/a'}% | ` +
        `slice=${sl ? `${sl.pct_of_doc}% of doc` : 'NONE'}${r.fallback_would_fire ? ' (⚠ PROD Haiku-fallback)' : ''}`,
    );
  }

  // Aggregate
  const agg = results.reduce(
    (a, r) => {
      a.gt += r.gt_total;
      a.found += r.found;
      a.notFound += r.not_found;
      a.inSlice += r.in_slice;
      a.outSlice += r.out_of_slice;
      return a;
    },
    { gt: 0, found: 0, notFound: 0, inSlice: 0, outSlice: 0 },
  );
  const aggCeiling = agg.inSlice + agg.outSlice > 0 ? +((agg.inSlice / (agg.inSlice + agg.outSlice)) * 100).toFixed(1) : null;

  console.log(
    `\n=== AGGREGATE: GT=${agg.gt} found=${agg.found} | in-slice=${agg.inSlice} out-of-slice=${agg.outSlice} | ` +
      `Mode-A structural recall ceiling = ${aggCeiling}% ===`,
  );

  // Write artifacts to vault
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const stamp = process.env.RECALL_STAMP ?? 'unstamped';
  writeFileSync(
    resolve(OUT_DIR, 'floor-results.json'),
    JSON.stringify({ generated_stamp: stamp, aggregate: { ...agg, ceiling_pct: aggCeiling }, docs: results }, null, 2),
  );

  const md = renderScorecard(results, agg, aggCeiling, stamp);
  writeFileSync(resolve(OUT_DIR, 'floor-scorecard.md'), md);
  console.log(`\nWrote: ${resolve(OUT_DIR, 'floor-scorecard.md')}`);
}

function renderScorecard(
  results: DocResult[],
  agg: { gt: number; found: number; notFound: number; inSlice: number; outSlice: number },
  aggCeiling: number | null,
  stamp: string,
): string {
  const rows = results
    .map((r) => {
      const id = r.identity as Record<string, string>;
      const carrier = (id.carrier ?? '?').toString().slice(0, 18);
      const sl = r.services_slice;
      return `| ${r.slug} | ${carrier} | ${r.gt_total} | ${r.found} | ${r.not_found} | ${r.in_slice} | ${r.out_of_slice} | **${r.structural_ceiling_pct ?? 'n/a'}%** | ${sl ? `${sl.pct_of_doc}%` : 'NONE'}${r.fallback_would_fire ? ' ⚠' : ''} |`;
    })
    .join('\n');
  return `# Comprehensive-extraction RECALL — structural floor (Mode-A)

**Generated**: ${stamp} · **Zero API spend** (deterministic segmentation + GT excerpt localization).

**What this measures**: of the ground-truth services in each combined SBC+EOC document, how many have their binding language INSIDE the single \`services_cost_sharing\` slice today's Mode-A path sends to Haiku, vs. in the EOC body Mode-A discards. The in-slice fraction is the **structural ceiling** on Mode-A recall — the number Mode-B (full-body sweep) must beat. Meet-or-beat floor for comprehensive_extraction.md §7 / Ship Gate G2.

**KNOWN APPROXIMATION**: PROD segments \`cleanupBoilerplate(ocr)\`; this segments raw OCR. \`not_found\` = GT excerpts not locatable in the OCR (GT-fidelity flag — adjudicate before trusting). \`⚠\` = PROD would fire the Haiku section-discovery fallback (regex found < 2 priority sections).

| Doc | Carrier | GT svcs | found | not_found | in-slice | out-of-slice | **Mode-A ceiling** | services slice (% of doc) |
|---|---|---|---|---|---|---|---|---|
${rows}
| **AGG** | — | **${agg.gt}** | **${agg.found}** | **${agg.notFound}** | **${agg.inSlice}** | **${agg.outSlice}** | **${aggCeiling}%** | — |

## Reading this
- **Mode-A ceiling ${aggCeiling}%** = the best recall today's path could achieve even with a perfect in-slice extractor. The rest (\`out-of-slice\`) is structurally unreachable — it never reaches the services prompt.
- A small **services slice (% of doc)** on a 190-page combined doc is the headline: the EOC's per-service binding narrative (the strongest cite-grade dispute evidence) is discarded before Haiku sees it.
- **Mode-B target**: recall meaningfully above ${aggCeiling}% on this corpus, without regressing the identity-scalar harness (opus-parser-calibration-2026-05-28) or precision (phantom-service rate).
`;
}

main();
