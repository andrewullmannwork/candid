/**
 * Ing-E Step 4 — redactor coverage completeness (Ship Gate G1).
 *
 * Asserts the `redactorWired` markers in surfaces.ts EXACTLY match the real
 * redactExcerpt(...,ctx) call sites in the codebase. A future shared-surface writer
 * therefore can't be added (or a chokepoint removed) without the marker — and hence
 * the backfill + audit scope — tracking it. Mechanizes the S166 writer-completeness
 * non-negotiable so it can't drift by convention.
 *
 * Run from the worktree root:
 *   npx tsx scripts/calibration/pii/redactor-coverage-completeness-fixture.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { WIRED_SURFACES } from "@/lib/parser/pii-surfaces";

// The write-path files that call redactExcerpt (the redactor chokepoints).
const CALL_SITE_FILES = [
  "src/lib/parser/promotion-event.ts",
  "src/lib/parser/canonical-haiku-extractions.ts",
  "src/lib/parser/code-identity.ts",
  "src/lib/parser/code-identity-promotion.ts",
  "src/lib/claims/service-resolver.ts",
  "src/lib/claims/code-intelligence.ts",
];

// ctx label (3rd arg of redactExcerpt) → the surface id(s) that write persists to.
// One chokepoint can serve multiple surfaces (the provenance writer covers both the
// plan and the service field_provenance columns).
const CTX_TO_SURFACES: Record<string, string[]> = {
  "field_provenance.sources[].excerpt": ["canonical_plans.field_provenance", "canonical_plan_services.field_provenance"],
  "canonical_haiku_extractions.source_excerpt": ["canonical_haiku_extractions.source_excerpt"],
  "billing_code_identity.description_examples": ["billing_code_identity.description_examples"],
  "billing_code_identity.corroborator_sources.raw_description": ["billing_code_identity.corroborator_sources"],
  "billing_code_mappings.provider_descriptions": ["billing_code_mappings.provider_descriptions"],
};

let pass = 0;
const fails: string[] = [];
const check = (label: string, cond: boolean): void => {
  if (cond) pass++;
  else fails.push(label);
};

// 1. Extract every redactExcerpt ctx label actually present in the code.
const CTX_RE = /redactExcerpt\([^,]+,[^,]+,\s*["']([^"']+)["']\s*\)/g;
const foundCtx = new Set<string>();
for (const rel of CALL_SITE_FILES) {
  const src = readFileSync(resolve(process.cwd(), rel), "utf8");
  for (const m of src.matchAll(CTX_RE)) foundCtx.add(m[1]);
}

// 2. Every ctx in code is accounted for (no unknown chokepoint), and every mapped ctx
//    actually appears in code (no stale map entry).
for (const ctx of foundCtx) check(`ctx mapped to a surface: ${ctx}`, ctx in CTX_TO_SURFACES);
for (const ctx of Object.keys(CTX_TO_SURFACES)) check(`mapped ctx present in code: ${ctx}`, foundCtx.has(ctx));

// 3. The surfaces the call sites persist to must EXACTLY equal the redactorWired set.
const fromCalls = new Set(Object.values(CTX_TO_SURFACES).flat());
const fromMarkers = new Set(WIRED_SURFACES.map((s) => s.id));
for (const id of fromCalls) check(`redactorWired marker exists for call-site surface: ${id}`, fromMarkers.has(id));
for (const id of fromMarkers) check(`call site exists for redactorWired surface: ${id}`, fromCalls.has(id));

const total = pass + fails.length;
console.log(`\nredactor-coverage completeness: ${pass}/${total} PASS`);
console.log(`  ctx labels found in code: ${foundCtx.size}; redactorWired surfaces: ${fromMarkers.size}`);
if (fails.length) {
  console.log(`${fails.length} FAILURE(S) — markers drifted from real redactExcerpt() call sites:`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log("✓ redactorWired markers == real redactExcerpt() chokepoints (G1 writer-completeness).\n");
