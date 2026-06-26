/**
 * Thesaurus Phase 1a — Step B (T3a) plan-doc routing logic fixture (no DB, no Haiku).
 *
 *   npx tsx scripts/calibration/fixtures/thesaurus-phase1a/routing.ts
 *
 * Proves the pure routing core (`applyThesaurusRouting` + `canonicalizeSlug`):
 *   1. A trustworthy cache hit (signature_cache / code_cache) WINS over the extractor slug.
 *   2. trigram_exact / haiku / none / missing-resolution do NOT win (extractor kept).
 *   3. The final slug is canonicalized via the rename-map — on the kept-extractor path
 *      AND on a (defensive) cache slug.
 *   4. The override is applied in LOCKSTEP to both the legacy and haiku arrays.
 *   5. cacheWins / slugChanged counts are correct (a cache hit equal to the extractor is
 *      neither a win nor a change).
 */
import {
  applyThesaurusRouting,
  canonicalizeSlug,
  acceptCodeAnchoredSlug,
  type ThesaurusRoutingResult,
} from "@/lib/plan_doc/thesaurus-routing";
import type { ResolutionSource } from "@/lib/claims/service-resolver";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.error(`  FAIL  ${name}`);
  }
}

console.log("Step B — plan-doc routing logic fixture\n");

// ── canonicalizeSlug unit ────────────────────────────────────────────────────
const renameMap = new Map<string, string>([
  ["dead5", "live5"],
  ["dead6", "live6"],
]);
check("canonicalizeSlug: dead slug -> live", canonicalizeSlug("dead5", renameMap) === "live5");
check("canonicalizeSlug: live slug unchanged", canonicalizeSlug("office_visit", renameMap) === "office_visit");

// ── acceptCodeAnchoredSlug unit (EOC Section-A: CODE-anchored ONLY) ───────────
// EOC prior-auth feeds criteria PROSE as the description → a signature/trigram match would be a
// wrong slug; only a code_cache hit may win.
check("acceptCodeAnchoredSlug: code_cache hit -> slug", acceptCodeAnchoredSlug({ slug: "imaging", source: "code_cache" }) === "imaging");
check("acceptCodeAnchoredSlug: signature_cache REJECTED (prose ≠ label)", acceptCodeAnchoredSlug({ slug: "wrong", source: "signature_cache" }) === null);
check("acceptCodeAnchoredSlug: trigram_exact REJECTED", acceptCodeAnchoredSlug({ slug: "wrong", source: "trigram_exact" }) === null);
check("acceptCodeAnchoredSlug: haiku REJECTED", acceptCodeAnchoredSlug({ slug: "wrong", source: "haiku" }) === null);
check("acceptCodeAnchoredSlug: undefined (no resolution) -> null", acceptCodeAnchoredSlug(undefined) === null);
check("acceptCodeAnchoredSlug: code_cache with null slug -> null", acceptCodeAnchoredSlug({ slug: null, source: "code_cache" }) === null);

// ── applyThesaurusRouting over a multi-service plan-doc ───────────────────────
// One service per scenario; legacy[i] and haiku[i] start with the SAME extractor slug.
const extractorSlugs = [
  "extractor0", // 0: signature_cache hit wins
  "extractor1", // 1: code_cache hit wins
  "extractor2", // 2: trigram_exact does NOT win
  "extractor3", // 3: haiku does NOT win
  "extractor4", // 4: none does NOT win
  "dead5", //     5: no resolution -> rename canonicalizes the kept extractor slug
  "extractor6", // 6: signature_cache hit returns a dead slug -> canonicalized
  "same7", //     7: cache hit equal to extractor -> not a win, not a change
];
const legacyServices: Array<{ serviceSlug: string; identityResolution?: { source: string } }> =
  extractorSlugs.map((s) => ({ serviceSlug: s }));
const haikuServices = extractorSlugs.map((s) => ({ serviceSlug: s }));

const mk = (slug: string | null, source: ResolutionSource) => ({ slug, source });
const resolutions = new Map<number, { slug: string | null; source: ResolutionSource }>([
  [0, mk("cache0", "signature_cache")],
  [1, mk("cache1", "code_cache")],
  [2, mk("trig2", "trigram_exact")],
  [3, mk("haiku3", "haiku")],
  [4, mk(null, "none")],
  // index 5: intentionally absent (no resolution)
  [6, mk("dead6", "signature_cache")],
  [7, mk("same7", "signature_cache")],
]);

const result: ThesaurusRoutingResult = applyThesaurusRouting({
  legacyServices,
  haikuServices,
  resolutions,
  renameMap,
});

const expected = ["cache0", "cache1", "extractor2", "extractor3", "extractor4", "live5", "live6", "same7"];
for (let i = 0; i < expected.length; i++) {
  check(`service[${i}] legacy slug -> ${expected[i]}`, legacyServices[i].serviceSlug === expected[i]);
  check(`service[${i}] lockstep (haiku === legacy)`, haikuServices[i].serviceSlug === legacyServices[i].serviceSlug);
}

// ── counts ────────────────────────────────────────────────────────────────────
// cache wins: 0,1,6 (cache replaced extractor) = 3. index 7's cache hit equals the
// extractor, so it is NOT a win. slugChanged: 0,1,5(rename),6 = 4.
check("total === 8", result.total === 8);
check("cacheWins === 3 (0,1,6; not 7)", result.cacheWins === 3);
check("slugChanged === 4 (0,1,5,6)", result.slugChanged === 4);

// ── A3: identity stamp on cache-WINS only ──────────────────────────────────────
// The synonym cache OVERRODE the extractor on 0 (signature), 1 (code), 6 (signature,
// dead→live). Those carry identityResolution.source. Non-wins do NOT: 2 (trigram, weak),
// 3 (haiku, weak), 4 (none), 5 (rename-only, no cache), 7 (concordant — cache === extractor).
check("service[0] identity stamp = signature_cache", legacyServices[0].identityResolution?.source === "signature_cache");
check("service[1] identity stamp = code_cache", legacyServices[1].identityResolution?.source === "code_cache");
check("service[6] identity stamp = signature_cache (dead→live)", legacyServices[6].identityResolution?.source === "signature_cache");
for (const i of [2, 3, 4, 5, 7]) {
  check(`service[${i}] NOT stamped (identity certain)`, legacyServices[i].identityResolution === undefined);
}

// ── empty input is a safe no-op ────────────────────────────────────────────────
const empty = applyThesaurusRouting({
  legacyServices: [],
  haikuServices: [],
  resolutions: new Map(),
  renameMap,
});
check("empty input: total/cacheWins/slugChanged all 0", empty.total === 0 && empty.cacheWins === 0 && empty.slugChanged === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
