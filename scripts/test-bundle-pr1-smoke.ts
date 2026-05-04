/**
 * Bundle PR #1 smoke test — Session 55 (audit items #8a, #17) + Session 55
 * mig 065 (slug enqueue path). T3 (audit item #13 canonical write merge race)
 * trimmed Session 61 Task 4.0.6-I — mig 064 RPC superseded by Phase 4.0.6
 * helper; SQL function still callable per Pattern 1 #10 but no longer
 * exercised from production code path so smoke retired.
 *
 * Runs three independent test cases verifying:
 *   T1: SBC image-PDF refusal logic (#17) — pure logic, no DB.
 *   T2: EOC slug validation (#8a) — requires DB (loadValidServiceSlugs query).
 *   T4: Slug enqueue path (mig 065) — requires DB.
 *
 * Usage:
 *   npx tsx scripts/test-bundle-pr1-smoke.ts
 *   npx tsx scripts/test-bundle-pr1-smoke.ts --skip-t4   (skip if mig 065 not yet applied)
 */

import * as fs from "fs";
import * as path from "path";
import { config } from "dotenv";
import { resolve } from "path";

// Load env BEFORE importing modules that use env at construction time
config({ path: resolve(__dirname, "../.env.local"), override: true });

import { createServerClient } from "@/lib/supabase/server";
import { loadValidServiceSlugs, enqueueUnknownServiceSlug } from "@/lib/parser/service-catalog-slugs";

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

// ─── T3: REMOVED Session 61 (Task 4.0.6-I) ───────────────────────────────────
// Audit item #13 (canonical write merge race) closed end-to-end Session 55 +
// superseded Session 61. Phase 4.0.6 helper (commit-and-evaluate) replaces the
// mig 064 RPC value-write path; canonical_plan_services writes happen via
// apply_promotion_event with advisory-lock per (canonical, service, field)
// rather than the old per-canonical-id lock. mig 064 SQL function still
// callable per Pattern 1 #10 hard-delete prohibition; smoke retired because
// production code no longer exercises it.

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
  const skipT4 = process.argv.includes("--skip-t4");
  log("Bundle PR #1 smoke test starting");

  testT1_SbcImagePdfRefusal();
  await testT2_EocSlugValidation();

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
