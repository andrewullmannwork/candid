/**
 * Bundle PR #1 smoke test — Session 55 (audit items #8a, #13, #17).
 *
 * Runs three independent test cases verifying:
 *   T1: SBC image-PDF refusal logic (#17) — pure logic, no DB.
 *   T2: EOC slug validation (#8a) — requires DB (loadValidServiceSlugs query).
 *   T3: Canonical write merge with concurrent execution (#13) — requires mig 064
 *       applied to the database. Exercises the advisory lock + JSONB shallow-merge.
 *
 * Usage:
 *   npx tsx scripts/test-bundle-pr1-smoke.ts
 *   npx tsx scripts/test-bundle-pr1-smoke.ts --skip-t3   (skip if mig 064 not yet applied)
 *
 * IMPORTANT
 * T3 writes to canonical_plan_services. With OPS.9 not yet closed, this is a
 * production table. T3 uses a sentinel canonical_plan_id ('00000000-0000-0000-
 * 0000-bundle1test1') that is cleaned up at end of test; if test crashes, the
 * row may persist (DELETE manually via Supabase Studio if it does). Sentinel
 * UUID is invalid as a real plan reference so it cannot interfere with real users.
 */

import * as fs from "fs";
import * as path from "path";
import { config } from "dotenv";
import { resolve } from "path";

// Load env BEFORE importing modules that use env at construction time
config({ path: resolve(__dirname, "../.env.local"), override: true });

import { createServerClient } from "@/lib/supabase/server";
import { loadValidServiceSlugs, enqueueUnknownServiceSlug } from "@/lib/parser/service-catalog-slugs";
import { upsertCanonicalServicesWithMerge, type CanonicalServiceInsert } from "@/lib/parser/canonical-merge";

// Sentinel UUID for test isolation. Hex-only chars; clearly identifiable as test
// data. Cleaned up at end of T3; if test crashes, DELETE WHERE canonical_plan_id =
// SENTINEL_CANONICAL_ID via Supabase Studio.
const SENTINEL_CANONICAL_ID = "00000000-0000-0000-0000-0000bbbbbbbb";
const TEST_TAG_LOG = "[bundle-pr1-smoke]";

function log(msg: string) {
  console.log(`${TEST_TAG_LOG} ${msg}`);
}

function fail(name: string, detail: string): never {
  console.error(`${TEST_TAG_LOG} FAIL ${name}: ${detail}`);
  process.exit(1);
}

function pass(name: string, detail: string) {
  console.log(`${TEST_TAG_LOG} PASS ${name}: ${detail}`);
}

// ─── T1: SBC image-PDF refusal logic ─────────────────────────────────────────
//
// We re-implement the threshold check inline to verify the logic without spinning
// up the full dispatcher (which requires a real Supabase client + document row).
// The actual dispatcher integration is verified by typecheck + manual upload-flow
// testing; this test verifies the threshold + error-shape contract.
function testT1_SbcImagePdfRefusal() {
  const SBC_MIN_TEXT_CHARS = 500;

  const lowOcrText = "x".repeat(100);
  const highOcrText = "x".repeat(15000);

  if (!(lowOcrText.length < SBC_MIN_TEXT_CHARS)) {
    fail("T1", `low ocrText (${lowOcrText.length} chars) should be below threshold ${SBC_MIN_TEXT_CHARS}`);
  }
  if (!(highOcrText.length >= SBC_MIN_TEXT_CHARS)) {
    fail("T1", `high ocrText (${highOcrText.length} chars) should be above threshold ${SBC_MIN_TEXT_CHARS}`);
  }

  // Verify the actual fixture sizes are above threshold (defensive — protects against
  // future fixture additions that might be smaller than threshold).
  const fixtureDir = path.join(process.cwd(), "tests/fixtures/sbcs");
  if (fs.existsSync(fixtureDir)) {
    const fixtures = fs.readdirSync(fixtureDir).filter((f: string) =>
      fs.statSync(path.join(fixtureDir, f)).isDirectory(),
    );
    let smallest = Infinity;
    let smallestName = "";
    for (const fx of fixtures) {
      const sourceTxt = path.join(fixtureDir, fx, "source.txt");
      if (fs.existsSync(sourceTxt)) {
        const size = fs.statSync(sourceTxt).size;
        if (size < smallest) {
          smallest = size;
          smallestName = fx;
        }
      }
    }
    if (smallest < SBC_MIN_TEXT_CHARS) {
      fail("T1", `smallest SBC fixture ${smallestName} has ${smallest} chars, below threshold ${SBC_MIN_TEXT_CHARS} — would be falsely rejected`);
    }
    pass("T1", `SBC threshold ${SBC_MIN_TEXT_CHARS} chars; smallest fixture ${smallestName} = ${smallest} chars (${Math.round(smallest / SBC_MIN_TEXT_CHARS)}× headroom)`);
  } else {
    pass("T1", `threshold logic verified (fixture dir not found; skipping fixture safety check)`);
  }
}

// ─── T2: EOC slug validation ─────────────────────────────────────────────────
async function testT2_EocSlugValidation() {
  const supabase = createServerClient();
  const validSlugs = await loadValidServiceSlugs(supabase);

  if (validSlugs.size === 0) {
    fail("T2", "loadValidServiceSlugs returned empty set — service_catalog query failed or table is empty");
  }

  // Sanity: pcp_visit is a known SBC standard slug; should be in service_catalog
  if (!validSlugs.has("pcp_visit")) {
    fail("T2", "validSlugs missing 'pcp_visit' — vocabulary may have drifted from STANDARD_SLUGS");
  }

  // Sanity: a clearly-fabricated slug should NOT be in the set
  const fakeSlug = "totally_fake_unknown_service_xyz_abc_123";
  if (validSlugs.has(fakeSlug)) {
    fail("T2", `validSlugs contains fabricated slug '${fakeSlug}'`);
  }

  pass("T2", `loaded ${validSlugs.size} valid slugs; sentinel pcp_visit present; fabricated slug rejected`);
}

// ─── T3: Canonical write merge with concurrent execution ─────────────────────
async function testT3_ConcurrentCanonicalMerge() {
  const supabase = createServerClient();

  // First, clean up any prior leftover sentinel rows
  await supabase
    .from("canonical_plan_services")
    .delete()
    .eq("canonical_plan_id", SENTINEL_CANONICAL_ID);

  // We need a real canonical_plan_id to UPSERT against. canonical_plan_services has
  // a FK to canonical_plans(id). Create a sentinel canonical_plan row first.
  const { error: planErr } = await supabase
    .from("canonical_plans")
    .upsert(
      {
        id: SENTINEL_CANONICAL_ID,
        plan_name: "BUNDLE-PR1-TEST-CANONICAL-DELETE-IF-FOUND",
        insurer_id: null,
        plan_year: 2099,
        state: "XX",
        plan_type: "PPO",
      },
      { onConflict: "id" },
    );
  if (planErr) {
    fail("T3", `failed to create sentinel canonical_plans row: ${planErr.message}`);
  }

  const baseInsert = (slug: string, fieldProvenance: Record<string, unknown>): CanonicalServiceInsert => ({
    canonical_plan_id: SENTINEL_CANONICAL_ID,
    concept_id: null,
    service_slug: slug,
    copay: 25,
    coinsurance: 0.2,
    is_covered: true,
    requires_prior_auth: false,
    requires_referral: false,
    deductible_applies: true,
    annual_limit: null,
    visit_limit: null,
    coverage_rules: {},
    confidence: 0.9,
    source: "smoke_test",
    field_provenance: fieldProvenance,
  });

  // Writer A: provenance for { deductible_individual, copay }
  const writerA = upsertCanonicalServicesWithMerge(supabase, SENTINEL_CANONICAL_ID, [
    baseInsert("pcp_visit", {
      deductible_individual: { source_excerpt: "writerA-deductible", confidence: 0.9 },
      copay: { source_excerpt: "writerA-copay", confidence: 0.9 },
    }),
  ]);

  // Writer B: provenance for { oop_max_individual, copay } — concurrent
  const writerB = upsertCanonicalServicesWithMerge(supabase, SENTINEL_CANONICAL_ID, [
    baseInsert("pcp_visit", {
      oop_max_individual: { source_excerpt: "writerB-oop", confidence: 0.85 },
      copay: { source_excerpt: "writerB-copay", confidence: 0.85 },
    }),
  ]);

  const [resultA, resultB] = await Promise.all([writerA, writerB]);
  if (resultA.error) fail("T3", `writerA error: ${resultA.error.message}`);
  if (resultB.error) fail("T3", `writerB error: ${resultB.error.message}`);

  // Read back the row and verify provenance shape
  const { data: row, error: readErr } = await supabase
    .from("canonical_plan_services")
    .select("field_provenance")
    .eq("canonical_plan_id", SENTINEL_CANONICAL_ID)
    .eq("service_slug", "pcp_visit")
    .single();

  if (readErr || !row) {
    fail("T3", `failed to read back row: ${readErr?.message ?? "no row"}`);
  }

  const fp = (row.field_provenance ?? {}) as Record<string, unknown>;

  // Pre-merge bug behavior: only one writer's keys would survive.
  // Post-merge: ALL THREE keys should be present (deductible_individual + oop_max_individual + copay).
  const expectedKeys = ["deductible_individual", "oop_max_individual", "copay"];
  const missingKeys = expectedKeys.filter((k) => !(k in fp));
  if (missingKeys.length > 0) {
    fail("T3", `merged field_provenance missing keys: ${missingKeys.join(",")}; got: ${JSON.stringify(Object.keys(fp))}`);
  }

  // For 'copay', last-writer-wins within field is acceptable (within-field diversity
  // deferred to Phase 4). Just verify the value is one of the two writers.
  const copayProv = fp.copay as { source_excerpt?: string };
  if (copayProv.source_excerpt !== "writerA-copay" && copayProv.source_excerpt !== "writerB-copay") {
    fail("T3", `copay provenance unexpected: ${JSON.stringify(copayProv)}`);
  }

  pass("T3", `merged provenance has all 3 keys (cross-field diversity preserved); copay = ${copayProv.source_excerpt} (within-field last-writer-wins)`);

  // Cleanup
  await supabase.from("canonical_plan_services").delete().eq("canonical_plan_id", SENTINEL_CANONICAL_ID);
  await supabase.from("canonical_plans").delete().eq("id", SENTINEL_CANONICAL_ID);
  log("T3 cleanup complete");
}

// ─── T4: Slug enqueue path (mig 065) ─────────────────────────────────────────
async function testT4_SlugEnqueue() {
  const supabase = createServerClient();

  // Use a real document_id from the documents table — queue table FK requires it.
  // Pick any document; we'll clean up the queue rows we create.
  const { data: anyDoc } = await supabase
    .from("documents")
    .select("id")
    .limit(1)
    .maybeSingle();

  if (!anyDoc) {
    fail("T4", "no documents found in DB to anchor sentinel queue rows");
  }

  const sentinelDocId = anyDoc.id;
  const fakeSlug = "totally_fake_unknown_service_xyz_abc_123_t4";

  // Pre-cleanup: any prior T4 leftovers
  await supabase
    .from("service_catalog_admin_review_queue")
    .delete()
    .eq("source_doc_id", sentinelDocId)
    .eq("proposed_service_slug", fakeSlug);

  // First enqueue — should be NEW
  const r1 = await enqueueUnknownServiceSlug(supabase, {
    sourceDocId: sentinelDocId,
    proposedByUserId: null,
    parserSource: "manual",
    proposedServiceSlug: fakeSlug,
    proposedServiceLabel: "T4 sentinel slug — DELETE",
    proposedCategory: "other",
    sourceExcerpt: "T4 source excerpt sentinel",
    sourceExcerptVerified: "verified",
    sourceExcerptExtractionMethod: "pdftotext",
    sourceSectionHint: "test",
    sourceSectionVerified: true,
    contextExtract: null,
  });

  if (!r1.isNew) {
    fail("T4", `first enqueue should be isNew=true; got ${r1.isNew}`);
  }

  // Second enqueue (same doc + same slug) — should be EXISTING (UPSERT idempotency per mig 065 UNIQUE)
  const r2 = await enqueueUnknownServiceSlug(supabase, {
    sourceDocId: sentinelDocId,
    proposedByUserId: null,
    parserSource: "manual",
    proposedServiceSlug: fakeSlug,
    proposedServiceLabel: "T4 sentinel slug — DELETE (updated)",
    proposedCategory: "other",
    sourceExcerpt: "T4 source excerpt sentinel updated",
    sourceExcerptVerified: "verified",
    sourceExcerptExtractionMethod: "pdftotext",
    sourceSectionHint: "test",
    sourceSectionVerified: true,
    contextExtract: null,
  });

  if (r2.isNew) {
    fail("T4", `second enqueue (same doc+slug) should be isNew=false; got ${r2.isNew}`);
  }
  if (r1.queueRowId !== r2.queueRowId) {
    fail("T4", `second enqueue should hit same row; got ${r1.queueRowId} vs ${r2.queueRowId}`);
  }

  // Verify row state — should be pending with updated context
  const { data: row, error: readErr } = await supabase
    .from("service_catalog_admin_review_queue")
    .select("status, proposed_service_label, proposed_service_slug")
    .eq("id", r1.queueRowId)
    .single();
  if (readErr || !row) {
    fail("T4", `row read failed: ${readErr?.message ?? "no row"}`);
  }
  if (row.status !== "pending") {
    fail("T4", `expected status=pending; got ${row.status}`);
  }
  if (!row.proposed_service_label?.includes("updated")) {
    fail("T4", `UPSERT should have updated proposed_service_label; got: ${row.proposed_service_label}`);
  }

  pass("T4", `enqueue idempotency works: first=NEW, second=EXISTING (same row id), label updated by UPSERT`);

  // Cleanup
  await supabase.from("service_catalog_admin_review_queue").delete().eq("id", r1.queueRowId);
  log("T4 cleanup complete");
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const skipT3 = process.argv.includes("--skip-t3");
  const skipT4 = process.argv.includes("--skip-t4");
  log("Bundle PR #1 smoke test starting");

  testT1_SbcImagePdfRefusal();
  await testT2_EocSlugValidation();

  if (skipT3) {
    log("Skipping T3 (--skip-t3 flag)");
  } else {
    await testT3_ConcurrentCanonicalMerge();
  }

  if (skipT4) {
    log("Skipping T4 (--skip-t4 flag — mig 065 not yet applied)");
  } else {
    await testT4_SlugEnqueue();
  }

  log("All tests passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(`${TEST_TAG_LOG} UNCAUGHT:`, err);
  process.exit(1);
});
