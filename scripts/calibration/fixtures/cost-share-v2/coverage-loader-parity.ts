/**
 * R1a (S240) coverage-loader PARITY GATE — buildPlanBenefitFromRow == the prior inline
 * per-row cite-grade loop that loadCoverage + loadCoverageFromCanonical ran (they were
 * ~90% identical; the loop is now shared). The `inlineBuild` below is a verbatim copy of
 * that prior loop body; the `shared` side is buildPlanBenefitFromRow. Deep-equal across the
 * cascade branches (user_doc / canonical_fallback / legacy_sbc_excerpt / identity-inferred),
 * the confidence floor, alias keying, and the user-vs-canonical opts.
 *
 * Run: npx tsx scripts/calibration/fixtures/cost-share-v2/coverage-loader-parity.ts
 */
import {
  buildPlanBenefitFromRow,
  type CoverageRowForBenefit,
  type CiteGradeContext,
  type PlanBenefitRowOpts,
} from "../../../../src/lib/disputes/evidence-resolver";
import { extractPatternP8FromEntry, isCitationGrade } from "../../../../src/lib/parser/consumer-read";
import { normalizeCoinsuranceForStorage } from "../../../../src/lib/billing/coinsurance";
import { resolveCoverageForLine } from "../../../../src/lib/claims/coverage-decision";

const MIN_PLAN_BENEFIT_CONFIDENCE = 0.5;

let pass = 0;
const fails: string[] = [];
function eq(name: string, shared: unknown, inline: unknown) {
  const A = JSON.stringify(shared);
  const B = JSON.stringify(inline);
  if (A === B) pass++;
  else fails.push(`✗ ${name}\n    shared=${A}\n    inline=${B}`);
}

// Verbatim reproduction of the prior loadCoverage/loadCoverageFromCanonical per-row loop
// body (the spec). Key order in `detail` MUST match buildPlanBenefitFromRow for string eq.
function inlineBuild(
  row: CoverageRowForBenefit,
  ctx: CiteGradeContext,
  opts: PlanBenefitRowOpts,
): { canonicalSlug: string; detail: unknown } | null {
  const confidence = row.confidence ?? 0.5;
  if (confidence < MIN_PLAN_BENEFIT_CONFIDENCE) return null;
  const primaryField = row.in_copay !== null ? "in_copay" : "in_coinsurance";
  const p8Entry = row.field_provenance?.[primaryField];
  const p8 = extractPatternP8FromEntry(p8Entry);
  const identityInferred =
    ctx.citeGradeGateOn &&
    p8Entry?.resolution_source != null &&
    p8Entry?.identity_confirmed !== true;
  const userRowCiteGrade = isCitationGrade(p8, { identityInferred });
  const canonicalFallback = !userRowCiteGrade
    ? ctx.canonicalCiteGradeBySlug.get(row.slug) ?? null
    : null;
  const preferredExcerpt = identityInferred
    ? null
    : p8?.source_excerpt ?? canonicalFallback?.sourceExcerpt ?? row.sbc_excerpt ?? null;
  const sbcExcerptVerified = !identityInferred && (userRowCiteGrade || canonicalFallback !== null);
  const citationSource = identityInferred
    ? null
    : userRowCiteGrade
    ? "user_doc"
    : canonicalFallback !== null
    ? "canonical_fallback"
    : row.sbc_excerpt
    ? "legacy_sbc_excerpt"
    : null;
  const canonicalSlug = ctx.coverageCanonicalMap.get(row.slug) ?? row.slug;
  // R2 (S242) — buildPlanBenefitFromRow now derives `covered` from this shared decision
  // and carries it on the detail; the spec mirrors it. `covered` below stays the prior
  // inline `row.covered !== false`, so this also re-proves the R2 covered projection.
  const coverageDecision = resolveCoverageForLine({ covered: row.covered }, null);
  return {
    canonicalSlug,
    detail: {
      covered: row.covered !== false,
      copay: row.in_copay,
      coinsurance: normalizeCoinsuranceForStorage(row.in_coinsurance),
      // S319 fixture audit — the shared loader gained three-valued
      // deductibleApplies at S308; the replica never learned it and every
      // parity case failed on exactly this missing key. Mirrors the shared
      // derivation (row value, else null).
      deductibleApplies: (row.in_deductible_applies as boolean | null) ?? null,
      source: row.source ?? opts.sourceDefault,
      confidence,
      citation: opts.buildCitation(row.name, row.sbc_page),
      sbcExcerpt: preferredExcerpt,
      sbcPage: row.sbc_page ?? null,
      sbcExcerptVerified,
      citationSource,
      sourcedFrom: opts.sourceTag,
      sourcedFromYear: opts.sourceYear,
      coverageDecision,
    },
  };
}

function parity(name: string, row: CoverageRowForBenefit, ctx: CiteGradeContext, opts: PlanBenefitRowOpts) {
  eq(name, buildPlanBenefitFromRow(row, ctx, opts), inlineBuild(row, ctx, opts));
}

// --- canned cite-grade provenance entries (shape per extractPatternP8FromEntry) ---
const citeEntry = {
  source: "doc_extraction",
  confidence: 0.9,
  last_corroborated_at: "2024-01-01T00:00:00Z",
  source_excerpt: "Office visit: $25 copay",
  source_excerpt_verified: "verified",
  source_excerpt_extraction_method: "pdftotext",
  source_section_hint: "Common Medical Events",
  source_section_verified: true,
} as const;
// inferred-identity: a cite-grade entry that ALSO carries an unconfirmed synonym cache-win.
const inferredEntry = { ...citeEntry, resolution_source: "signature_cache" } as const;

const USER_OPTS: PlanBenefitRowOpts = {
  sourceTag: "user_exact",
  sourceYear: null,
  sourceDefault: "unknown",
  buildCitation: (name, page) => `Plan SBC${page ? `, page ${page}` : ""} — ${name}`,
};
const CANON_OPTS: PlanBenefitRowOpts = {
  sourceTag: "canonical_archive",
  sourceYear: 2024,
  sourceDefault: "canonical",
  buildCitation: (name) => `Summary of Benefits and Coverage — ${name}`,
};
const ctxOff = (over: Partial<CiteGradeContext> = {}): CiteGradeContext => ({
  citeGradeGateOn: false,
  canonicalCiteGradeBySlug: new Map(),
  coverageCanonicalMap: new Map(),
  ...over,
});

// C1 — user row, cite-grade P-8 → user_doc; p8 excerpt preferred over the legacy column.
parity("C1 user cite-grade → user_doc",
  { covered: true, in_copay: 25, in_coinsurance: null, source: "doc_extraction", confidence: 0.9, sbc_excerpt: "LEGACY", sbc_page: 3, field_provenance: { in_copay: { ...citeEntry } }, slug: "pcp_visit", name: "Primary care visit" },
  ctxOff(), USER_OPTS);

// C2 — no P-8 → canonical_haiku fallback.
parity("C2 canonical fallback",
  { covered: true, in_copay: 25, in_coinsurance: null, source: "doc_extraction", confidence: 0.8, sbc_excerpt: null, sbc_page: null, field_provenance: null, slug: "pcp_visit", name: "Primary care visit" },
  ctxOff({ canonicalCiteGradeBySlug: new Map([["pcp_visit", { sourceExcerpt: "CANON", sourceSectionHint: "" }]]) }), USER_OPTS);

// C3 — no P-8, no canonical fallback, legacy sbc_excerpt present → legacy_sbc_excerpt.
parity("C3 legacy sbc_excerpt",
  { covered: true, in_copay: 40, in_coinsurance: null, source: "sbc_parsed", confidence: 0.7, sbc_excerpt: "LEGACY", sbc_page: 5, field_provenance: null, slug: "specialist_visit", name: "Specialist" },
  ctxOff(), USER_OPTS);

// C4 — identity-inferred (gate ON) → excerpt nulled, citationSource null.
parity("C4 identity-inferred suppresses excerpt",
  { covered: true, in_copay: 25, in_coinsurance: null, source: "doc_extraction", confidence: 0.95, sbc_excerpt: "LEGACY", sbc_page: 2, field_provenance: { in_copay: { ...inferredEntry } }, slug: "pcp_visit", name: "Primary care visit" },
  ctxOff({ citeGradeGateOn: true }), USER_OPTS);

// C5 — below the confidence floor → null (skipped).
parity("C5 below confidence floor → null",
  { covered: true, in_copay: 25, in_coinsurance: null, source: "doc_extraction", confidence: 0.4, sbc_excerpt: null, sbc_page: null, field_provenance: null, slug: "pcp_visit", name: "Primary care visit" },
  ctxOff(), USER_OPTS);

// C6 — coinsurance-primary (in_copay null) → primaryField switches to in_coinsurance.
parity("C6 coinsurance-primary",
  { covered: true, in_copay: null, in_coinsurance: 0.2, source: "doc_extraction", confidence: 0.9, sbc_excerpt: null, sbc_page: null, field_provenance: { in_coinsurance: { ...citeEntry } }, slug: "imaging", name: "Imaging" },
  ctxOff(), USER_OPTS);

// C7 — canonical opts: sbc_excerpt/sbc_page null, canonical citation + source default.
parity("C7 canonical opts (fallback excerpt)",
  { covered: true, in_copay: 0, in_coinsurance: null, source: null, confidence: 0.8, sbc_excerpt: null, sbc_page: null, field_provenance: null, slug: "specialist_visit", name: "Specialist" },
  ctxOff({ canonicalCiteGradeBySlug: new Map([["specialist_visit", { sourceExcerpt: "CANON", sourceSectionHint: "" }]]) }), CANON_OPTS);

// C8 — alias keying: coverageCanonicalMap remaps the raw slug.
parity("C8 alias keying",
  { covered: true, in_copay: 30, in_coinsurance: null, source: "doc_extraction", confidence: 0.9, sbc_excerpt: null, sbc_page: null, field_provenance: null, slug: "raw_alias", name: "Aliased service" },
  ctxOff({ coverageCanonicalMap: new Map([["raw_alias", "canonical_target"]]) }), USER_OPTS);

// C9 — covered false propagates.
parity("C9 covered false",
  { covered: false, in_copay: null, in_coinsurance: null, source: "doc_extraction", confidence: 0.9, sbc_excerpt: null, sbc_page: null, field_provenance: null, slug: "cosmetic", name: "Cosmetic" },
  ctxOff(), USER_OPTS);

// C10 — user source null → sourceDefault "unknown".
parity("C10 user source null → unknown",
  { covered: true, in_copay: 20, in_coinsurance: null, source: null, confidence: 0.9, sbc_excerpt: null, sbc_page: null, field_provenance: null, slug: "pcp_visit", name: "Primary care visit" },
  ctxOff(), USER_OPTS);

// R1c — coinsurance normalized to decimal [0,1] at load (drifted percent → decimal; decimal preserved).
{
  const pct = buildPlanBenefitFromRow(
    { covered: true, in_copay: null, in_coinsurance: 20, source: "doc_extraction", confidence: 0.9, sbc_excerpt: null, sbc_page: null, field_provenance: null, slug: "imaging", name: "Imaging" },
    ctxOff(), USER_OPTS,
  );
  eq("R1c percent 20 → 0.20", pct?.detail.coinsurance, 0.2);
  const dec = buildPlanBenefitFromRow(
    { covered: true, in_copay: null, in_coinsurance: 0.3, source: "doc_extraction", confidence: 0.9, sbc_excerpt: null, sbc_page: null, field_provenance: null, slug: "imaging", name: "Imaging" },
    ctxOff(), USER_OPTS,
  );
  eq("R1c decimal 0.3 → 0.3", dec?.detail.coinsurance, 0.3);
}

if (fails.length) {
  console.error(`\ncoverage-loader-parity: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error("  " + f);
  process.exit(1);
}
console.log(`\ncoverage-loader-parity: ${pass} passed, 0 failed`);
console.log("ALL GREEN ✓");
