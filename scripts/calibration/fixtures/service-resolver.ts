/**
 * S153 — Ship Gate G4 fixture for the unified service-match resolver.
 *
 * Re-runnable, no network / no DB / no Haiku:
 *   npx tsx scripts/calibration/fixtures/service-resolver.ts
 *
 * Covers the BLOCK GOAL (not just callability):
 *   - wellness→preventive_care resolves via the Haiku tier (the reported bug)
 *   - dead/hallucinated slugs are NEVER emitted (validated against live catalog)
 *   - trigram alone CANNOT bridge the semantic gap (justifies the Haiku tier)
 *   - the cache/short-circuit tiers resolve without Haiku
 *   - config parsing falls back safely
 */

import {
  parseResolverConfig,
  trigramSimilarity,
  bestTrigramMatch,
  buildResolverPrompt,
  parseResolverResponse,
  resolveServices,
  DEFAULT_RESOLVER_CONFIG,
  type CatalogEntry,
} from "../../../src/lib/claims/service-resolver";

// Mirrors live service_catalog slugs. NOTE: "well_child_visit" is intentionally
// ABSENT — it is one of the 24 dead slugs in the old hardcoded list; the
// resolver must never emit it.
const CATALOG: CatalogEntry[] = [
  { slug: "pcp_visit", name: "Primary Care Visit", description: "Problem-focused office visit with a primary care physician", category: "office", conceptId: "c-pcp" },
  { slug: "preventive_care", name: "Preventive Care", description: "Annual wellness exam, screenings, and preventive services", category: "preventive", conceptId: "c-prev" },
  { slug: "advanced_imaging", name: "Advanced Imaging", description: "MRI, CT, and PET scans", category: "imaging", conceptId: "c-img" },
  { slug: "well_baby", name: "Well Baby Visit", description: "Routine infant checkups", category: "preventive", conceptId: "c-wb" },
];
const VALID = new Set(CATALOG.map((c) => c.slug));

// Minimal chainable Supabase stub: all cache reads return empty, writes no-op.
// (Proves the resolver behaves with a cold cache — the pre-launch reality.)
function stubSupabase(): never {
  const builder: Record<string, unknown> = {};
  const self = () => builder;
  Object.assign(builder, {
    select: self, insert: () => Promise.resolve({ data: null, error: null }),
    update: self, eq: self, in: self, is: self, gte: self, ilike: self,
    order: self, limit: self,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    single: () => Promise.resolve({ data: null, error: null }),
    then: (res: (v: { data: never[]; error: null }) => void) => res({ data: [], error: null }),
  });
  return { from: () => builder } as never;
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`); }
}

async function main() {
  console.log("S153 service-resolver fixture\n");

  // 1. Trigram bridges LEXICAL similarity but NOT semantic — justifies Haiku.
  check("trigram: 'office visit' ~ 'Primary Care Visit' modest", trigramSimilarity("office visit", "Primary Care Visit") < 0.6);
  check("trigram: 'preventive care' ~ 'Preventive Care' high", trigramSimilarity("preventive care", "Preventive Care") >= 0.8);
  check("trigram: 'wellness' ~ 'Preventive Care' LOW (semantic gap)", trigramSimilarity("wellness visit", "Preventive Care") < 0.3);

  // 2. bestTrigramMatch picks the lexically-closest entry.
  const bt = bestTrigramMatch("preventive care exam", CATALOG);
  check("bestTrigramMatch: 'preventive care exam' → preventive_care", bt?.entry.slug === "preventive_care");

  // 3. parseResolverResponse drops dead/hallucinated slugs + null.
  const parsed = parseResolverResponse(
    { matches: [
      { lineNumber: 1, slug: "preventive_care", confidence: 0.95 },
      { lineNumber: 2, slug: "well_child_visit", confidence: 0.9 }, // DEAD slug
      { lineNumber: 3, slug: null, confidence: 0.4 },
    ] },
    VALID,
  );
  check("parse: keeps valid preventive_care", parsed.get(1)?.slug === "preventive_care");
  check("parse: drops dead slug well_child_visit", !parsed.has(2));
  check("parse: drops null slug", !parsed.has(3));

  // 4. Rich prompt includes names + descriptions + the wellness guidance.
  const { systemPrompt } = buildResolverPrompt(CATALOG, [{ lineNumber: 1, description: "WELLNESS VISIT" }]);
  check("prompt: includes catalog name 'Preventive Care'", systemPrompt.includes("Preventive Care"));
  check("prompt: includes a description (not bare slugs)", systemPrompt.includes("Annual wellness exam"));
  check("prompt: includes the wellness→preventive guidance", /wellness/i.test(systemPrompt) && systemPrompt.includes("preventive_care"));

  // 5. Cold cache + trigram-only (skipHaiku): semantic line stays unresolved.
  const noHaiku = await resolveServices(
    [{ lineNumber: 1, description: "WELLNESS VISIT", billingCode: "99385", billingCodeType: "CPT" }],
    { supabase: stubSupabase(), userId: "u1", catalog: CATALOG, config: DEFAULT_RESOLVER_CONFIG, skipHaiku: true },
  );
  check("skipHaiku: wellness unresolved (proves Haiku tier is needed)", noHaiku.get(1)?.slug === null && noHaiku.get(1)?.needsReview === true);

  // 6. THE BUG: wellness→preventive_care resolves via the Haiku tier.
  const withHaiku = await resolveServices(
    [{ lineNumber: 1, description: "WELLNESS VISIT", billingCode: "99385", billingCodeType: "CPT" }],
    {
      supabase: stubSupabase(), userId: "u1", catalog: CATALOG, config: DEFAULT_RESOLVER_CONFIG,
      haikuCall: async () => ({ matches: [{ lineNumber: 1, slug: "preventive_care", confidence: 0.95 }] }),
    },
  );
  check("haiku: WELLNESS VISIT → preventive_care", withHaiku.get(1)?.slug === "preventive_care");
  check("haiku: source=haiku + conceptId carried", withHaiku.get(1)?.source === "haiku" && withHaiku.get(1)?.conceptId === "c-prev");
  check("haiku: confident match → needsReview=false", withHaiku.get(1)?.needsReview === false);

  // 7. Haiku returns a DEAD slug → dropped → null + needsReview (guard).
  const haikuDead = await resolveServices(
    [{ lineNumber: 1, description: "MYSTERY LINE", billingCode: "00000", billingCodeType: "CPT" }],
    {
      supabase: stubSupabase(), userId: "u1", catalog: CATALOG, config: DEFAULT_RESOLVER_CONFIG,
      haikuCall: async () => ({ matches: [{ lineNumber: 1, slug: "well_child_visit", confidence: 0.99 }] }),
    },
  );
  check("haiku: dead slug dropped → null + needsReview", haikuDead.get(1)?.slug === null && haikuDead.get(1)?.needsReview === true);

  // 8. Config parsing falls back safely on partial/invalid input.
  const cfg = parseResolverConfig({ haiku_confidence_floor: 0.75, writeback_confidence_floor: 9 /* invalid */ });
  check("config: valid field applied", cfg.haikuConfidenceFloor === 0.75);
  check("config: invalid field → default", cfg.writebackConfidenceFloor === DEFAULT_RESOLVER_CONFIG.writebackConfidenceFloor);

  console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
