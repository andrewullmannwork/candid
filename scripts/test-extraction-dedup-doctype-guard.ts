/**
 * S73.5 D1 — Plan-document-only smart-skip guard test
 *
 * Validates that `shouldSkipExtraction` refuses to smart-skip non-plan
 * documents (bills, EOBs, insurance cards, "other"). The structural guard
 * codifies [[Candid_Data_Patterns]] Pattern 1 #16 + [[Candid_10k]] §3.1 #6.
 *
 * Run: `npx tsx scripts/test-extraction-dedup-doctype-guard.ts`
 *
 * Test strategy: pure-function asserts on `isPlanDocumentType()` + behavioral
 * asserts on `shouldSkipExtraction()` with a stub Supabase client (no DB
 * dependency). All asserts in-process; no auth, no network.
 */

import {
  PLAN_DOCUMENT_TYPES,
  isPlanDocumentType,
  shouldSkipExtraction,
  type PlanIdentifiers,
} from "@/lib/plan/extraction-dedup";
import type { ClassifiedDocType } from "@/lib/classifier";

let pass = 0;
let fail = 0;

function assert(cond: boolean, label: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.error(`  ✗ ${label}`);
  }
}

// ── Stub Supabase client ─────────────────────────────────────────────────────
// shouldSkipExtraction's plan-doc guard runs BEFORE any DB access when docType
// is provided, so we can assert the early-exit path without touching the DB.
// For the !docType-provided fallback path, the stub returns a pre-set doc row.
type StubResponse = { data: unknown; error: null };
type StubBuilder = {
  select: (cols?: string) => StubBuilder;
  eq: (col: string, val: unknown) => StubBuilder;
  neq: (col: string, val: unknown) => StubBuilder;
  limit: (n: number) => StubBuilder;
  maybeSingle: () => Promise<StubResponse>;
  single: () => Promise<StubResponse>;
};

function makeStubSupabase(documentRow: { doc_type: string | null } | null): unknown {
  const builder: StubBuilder = {
    select: () => builder,
    eq: () => builder,
    neq: () => builder,
    limit: () => builder,
    maybeSingle: async () => ({ data: documentRow, error: null }),
    single: async () => ({ data: documentRow, error: null }),
  };
  return {
    from: (_table: string) => builder,
  };
}

const dummyIdentifiers: PlanIdentifiers = {
  insurer: "Test Insurer",
  planName: "Test Plan",
  groupNumber: null,
  planYear: 2026,
  planType: "PPO",
  state: "CA",
  source: "regex",
};

// ── Tests ────────────────────────────────────────────────────────────────────

async function run() {
  console.log("\n=== S73.5 D1: Plan-document-only smart-skip guard ===\n");

  // Pure-function: PLAN_DOCUMENT_TYPES whitelist
  console.log("[1] PLAN_DOCUMENT_TYPES constant");
  assert(
    PLAN_DOCUMENT_TYPES.includes("sbc"),
    "PLAN_DOCUMENT_TYPES includes 'sbc'",
  );
  assert(
    PLAN_DOCUMENT_TYPES.includes("plan_document"),
    "PLAN_DOCUMENT_TYPES includes 'plan_document'",
  );
  assert(
    PLAN_DOCUMENT_TYPES.includes("eoc"),
    "PLAN_DOCUMENT_TYPES includes 'eoc'",
  );
  assert(
    !(PLAN_DOCUMENT_TYPES as readonly string[]).includes("eob"),
    "PLAN_DOCUMENT_TYPES excludes 'eob'",
  );
  assert(
    !(PLAN_DOCUMENT_TYPES as readonly string[]).includes("itemized_bill"),
    "PLAN_DOCUMENT_TYPES excludes 'itemized_bill'",
  );
  assert(
    !(PLAN_DOCUMENT_TYPES as readonly string[]).includes("insurance_card"),
    "PLAN_DOCUMENT_TYPES excludes 'insurance_card'",
  );
  assert(
    !(PLAN_DOCUMENT_TYPES as readonly string[]).includes("other"),
    "PLAN_DOCUMENT_TYPES excludes 'other'",
  );
  // education_doc is intentionally Phase 2 (Subplan §2.4(c))
  assert(
    !(PLAN_DOCUMENT_TYPES as readonly string[]).includes("education_doc"),
    "PLAN_DOCUMENT_TYPES excludes 'education_doc' (Phase 2 deferred)",
  );

  // Pure-function: isPlanDocumentType
  console.log("\n[2] isPlanDocumentType()");
  assert(isPlanDocumentType("sbc") === true, "isPlanDocumentType('sbc') === true");
  assert(
    isPlanDocumentType("plan_document") === true,
    "isPlanDocumentType('plan_document') === true",
  );
  assert(isPlanDocumentType("eoc") === true, "isPlanDocumentType('eoc') === true");
  assert(isPlanDocumentType("eob") === false, "isPlanDocumentType('eob') === false");
  assert(
    isPlanDocumentType("itemized_bill") === false,
    "isPlanDocumentType('itemized_bill') === false",
  );
  assert(
    isPlanDocumentType("insurance_card") === false,
    "isPlanDocumentType('insurance_card') === false",
  );
  assert(isPlanDocumentType(null) === false, "isPlanDocumentType(null) === false");
  assert(isPlanDocumentType(undefined) === false, "isPlanDocumentType(undefined) === false");
  assert(isPlanDocumentType("") === false, "isPlanDocumentType('') === false");

  // Behavioral: shouldSkipExtraction refuses non-plan docs (docType param path)
  console.log("\n[3] shouldSkipExtraction() — explicit docType param");
  const stub = makeStubSupabase({ doc_type: "eob" }) as Parameters<
    typeof shouldSkipExtraction
  >[0];

  const eobResult = await shouldSkipExtraction(
    stub,
    "doc-1",
    "abc123" + "0".repeat(58),
    dummyIdentifiers,
    "user-1",
    "eob" as ClassifiedDocType,
  );
  assert(eobResult.skip === false, "eob → skip=false");
  assert(eobResult.reason === "not_a_plan_document", "eob → reason='not_a_plan_document'");

  const billResult = await shouldSkipExtraction(
    stub,
    "doc-2",
    "abc123" + "0".repeat(58),
    dummyIdentifiers,
    "user-1",
    "itemized_bill" as ClassifiedDocType,
  );
  assert(billResult.skip === false, "itemized_bill → skip=false");
  assert(
    billResult.reason === "not_a_plan_document",
    "itemized_bill → reason='not_a_plan_document'",
  );

  const cardResult = await shouldSkipExtraction(
    stub,
    "doc-3",
    "abc123" + "0".repeat(58),
    dummyIdentifiers,
    "user-1",
    "insurance_card" as ClassifiedDocType,
  );
  assert(cardResult.skip === false, "insurance_card → skip=false");
  assert(
    cardResult.reason === "not_a_plan_document",
    "insurance_card → reason='not_a_plan_document'",
  );

  // Behavioral: shouldSkipExtraction admits plan docs past the guard.
  // Plan docs reach Step 1 (file hash match) and return NO_SKIP because
  // the stub has no documents matching the hash — the assertion is that
  // the reason ISN'T 'not_a_plan_document' (i.e., they passed the guard).
  console.log("\n[4] shouldSkipExtraction() — plan docs pass the guard");
  const sbcStub = makeStubSupabase(null) as Parameters<typeof shouldSkipExtraction>[0];
  const sbcResult = await shouldSkipExtraction(
    sbcStub,
    "doc-4",
    "abc123" + "0".repeat(58),
    dummyIdentifiers,
    "user-1",
    "sbc" as ClassifiedDocType,
  );
  assert(sbcResult.reason !== "not_a_plan_document", "sbc passes the doc-type guard");

  const planDocResult = await shouldSkipExtraction(
    sbcStub,
    "doc-5",
    "abc123" + "0".repeat(58),
    dummyIdentifiers,
    "user-1",
    "plan_document" as ClassifiedDocType,
  );
  assert(
    planDocResult.reason !== "not_a_plan_document",
    "plan_document passes the doc-type guard",
  );

  const eocResult = await shouldSkipExtraction(
    sbcStub,
    "doc-6",
    "abc123" + "0".repeat(58),
    dummyIdentifiers,
    "user-1",
    "eoc" as ClassifiedDocType,
  );
  assert(eocResult.reason !== "not_a_plan_document", "eoc passes the doc-type guard");

  // Behavioral: legacy callers (no docType) trigger DB fallback fetch
  console.log("\n[5] shouldSkipExtraction() — legacy fallback (no docType param)");
  const eobFallbackStub = makeStubSupabase({ doc_type: "eob" }) as Parameters<
    typeof shouldSkipExtraction
  >[0];
  const fallbackResult = await shouldSkipExtraction(
    eobFallbackStub,
    "doc-7",
    "abc123" + "0".repeat(58),
    dummyIdentifiers,
    "user-1",
    // no docType arg — should fall back to DB lookup
  );
  assert(
    fallbackResult.skip === false,
    "legacy fallback (no docType) on eob → skip=false",
  );
  assert(
    fallbackResult.reason === "not_a_plan_document",
    "legacy fallback (no docType) on eob → reason='not_a_plan_document'",
  );

  // Summary
  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`);
  if (fail > 0) process.exit(1);
}

run().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
