/**
 * S99 B5 — mig 108 verification fixture for evaluate_pattern1_corroboration.
 *
 * Synthetic test: insert 2 service_catalog rows sharing 1 concept_id (one
 * canonical + one alias), 3 phone+email-verified users with cite-grade
 * plan_covered_services rows split between the two slugs (2 on canonical,
 * 1 on alias) but converging on the same field value.
 *
 * Pre-mig-108 (slug-grouped counting): 2 users on canonical + 1 user on alias
 * → max same-value count = 2 → should_promote = false (threshold not met).
 * Post-mig-108 (concept-grouped counting): all 3 users count → max same-value
 * count = 3 → should_promote = true (threshold met).
 *
 * The script:
 *   1. Cleans up any prior run state (idempotent).
 *   2. Inserts test fixtures.
 *   3. Calls evaluate_pattern1_corroboration with both alias slug AND
 *      canonical slug inputs.
 *   4. Asserts: distinct_user_count=3, same_value_count=3,
 *      should_promote=true, canonical_service_slug=canonical, sibling_slugs_count=2.
 *   5. Cleans up test data.
 *   6. Exits 0 on all-pass; 1 on any assertion failure.
 *
 * Run: `npx tsx scripts/findings/s99-b5/test-pattern1-concept-grouped.ts`
 *
 * Requires: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local
 *
 * Safe to run multiple times. Test data is namespaced with the prefix
 * 's99b5-test-' so it won't collide with real data; cleanup is keyed on
 * that prefix.
 */

import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
import { randomUUID } from "node:crypto";

loadEnv({ path: ".env.local" });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Test data identifiers (prefixed for safe cleanup)
const TEST_PREFIX = "s99b5-test-";
const CANONICAL_SLUG = `${TEST_PREFIX}canonical-pt`;
const ALIAS_SLUG = `${TEST_PREFIX}alias-physio`;
const TEST_CONCEPT_CODE = `${TEST_PREFIX}pt-concept`;
const TEST_CONCEPT_NAME = "S99 B5 test — physical therapy";
const TEST_PLAN_NAME = `${TEST_PREFIX}plan`;
const FIELD_NAME = "in_copay";
const COMMON_VALUE = 30;

let pass = 0;
let fail = 0;
const failures: string[] = [];

function expect(label: string, actual: unknown, expected: unknown): void {
  const matches = JSON.stringify(actual) === JSON.stringify(expected);
  if (matches) {
    console.log(`  ✅ ${label}`);
    pass++;
  } else {
    console.log(`  ❌ ${label}`);
    console.log(`     expected: ${JSON.stringify(expected)}`);
    console.log(`     actual:   ${JSON.stringify(actual)}`);
    failures.push(label);
    fail++;
  }
}

async function cleanup(): Promise<void> {
  console.log("Cleaning up any prior test state...");
  // Delete in FK-safe order: plan_covered_services → insurance_plans →
  // canonical_plan_services → canonical_plans → service_catalog → concepts → users.

  const { data: testPlans } = await supabase
    .from("canonical_plans")
    .select("id")
    .eq("plan_name", TEST_PLAN_NAME);
  const planIds = (testPlans ?? []).map((p) => (p as { id: string }).id);

  if (planIds.length > 0) {
    const { data: userPlans } = await supabase
      .from("insurance_plans")
      .select("id")
      .in("canonical_plan_id", planIds);
    const userPlanIds = (userPlans ?? []).map((p) => (p as { id: string }).id);
    if (userPlanIds.length > 0) {
      await supabase.from("plan_covered_services").delete().in("insurance_plan_id", userPlanIds);
    }
    await supabase.from("insurance_plans").delete().in("canonical_plan_id", planIds);
    await supabase.from("canonical_plan_services").delete().in("canonical_plan_id", planIds);
    await supabase.from("canonical_plans").delete().in("id", planIds);
  }

  // Drop alias first (FK to canonical via concept_id matters for trigger; but
  // since we're deleting both, deletion order shouldn't trip the trigger which
  // only validates on INSERT/UPDATE).
  await supabase.from("service_catalog").delete().in("slug", [ALIAS_SLUG, CANONICAL_SLUG]);

  // concepts table uses vocabulary_id + concept_code + concept_class
  await supabase
    .from("concepts")
    .delete()
    .eq("vocabulary_id", "CANDID")
    .eq("concept_code", TEST_CONCEPT_CODE);

  await supabase.from("users").delete().like("email", `${TEST_PREFIX}%`);
}

async function setup(): Promise<{
  canonicalPlanId: string;
  userIds: string[];
  conceptId: string;
}> {
  console.log("Setting up test fixtures...");

  // 1. Concept (service-class, CANDID vocabulary). Matches S94 reset-and-reseed
  //    pattern: vocabulary_id='CANDID', concept_class='service'.
  const conceptId = randomUUID();
  const { error: conceptErr } = await supabase.from("concepts").insert({
    id: conceptId,
    vocabulary_id: "CANDID",
    concept_code: TEST_CONCEPT_CODE,
    concept_name: TEST_CONCEPT_NAME,
    concept_class: "service",
    domain: "service",
  });
  if (conceptErr) throw new Error(`concept insert: ${conceptErr.message}`);

  // 2. Service catalog — insert canonical FIRST (separate call), then alias.
  //    The enforce_canonical_per_concept trigger (mig 103) rejects alias
  //    inserts whose concept_id has no sibling canonical row yet, so the
  //    canonical must be visible before the alias INSERT fires.
  const { error: canonicalErr } = await supabase.from("service_catalog").insert({
    slug: CANONICAL_SLUG,
    name: "PT Rehab (S99 B5 test canonical)",
    category: "therapy",
    concept_id: conceptId,
    canonical_for_concept: true,
    proposal_state: "canonical",
  });
  if (canonicalErr) throw new Error(`service_catalog canonical insert: ${canonicalErr.message}`);

  const { error: aliasErr } = await supabase.from("service_catalog").insert({
    slug: ALIAS_SLUG,
    name: "Physical Therapy (S99 B5 test alias)",
    category: "therapy",
    concept_id: conceptId,
    canonical_for_concept: false,
    proposal_state: "alias",
  });
  if (aliasErr) throw new Error(`service_catalog alias insert: ${aliasErr.message}`);

  // 3. Get service_id for each
  const { data: serviceRows, error: scErr } = await supabase
    .from("service_catalog")
    .select("id, slug")
    .in("slug", [CANONICAL_SLUG, ALIAS_SLUG]);
  if (scErr) throw new Error(`service_catalog read: ${scErr.message}`);
  const canonicalServiceId = serviceRows!.find((r) => r.slug === CANONICAL_SLUG)!.id;
  const aliasServiceId = serviceRows!.find((r) => r.slug === ALIAS_SLUG)!.id;

  // 4. Canonical plan (canonical_plans uses insurer_id FK to insurer_catalog,
  //    which we leave NULL to keep the fixture minimal — only plan_name is
  //    NOT NULL).
  const canonicalPlanId = randomUUID();
  const { error: cpErr } = await supabase.from("canonical_plans").insert({
    id: canonicalPlanId,
    plan_name: TEST_PLAN_NAME,
    state: "CA",
    plan_year: 2026,
  });
  if (cpErr) throw new Error(`canonical_plans insert: ${cpErr.message}`);

  // 5. 3 phone+email-verified users
  const userIds: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const userId = randomUUID();
    const { error: userErr } = await supabase.from("users").insert({
      id: userId,
      firebase_uid: `${TEST_PREFIX}firebase-${i}`,
      email: `${TEST_PREFIX}user${i}@test.local`,
      email_verified: true,
      phone_verified: true,
      phone_e164: `+1555555010${i}`,
    });
    if (userErr) throw new Error(`user insert: ${userErr.message}`);
    userIds.push(userId);
  }

  // 6. Each user gets an insurance_plans row linked to canonicalPlanId
  // + a plan_covered_services row with field_provenance containing
  // cite-grade in_copay = COMMON_VALUE. Users 1+2 use canonical slug;
  // user 3 uses alias slug.
  for (let i = 0; i < 3; i++) {
    const userId = userIds[i];
    const planId = randomUUID();
    const { error: ipErr } = await supabase.from("insurance_plans").insert({
      id: planId,
      user_id: userId,
      canonical_plan_id: canonicalPlanId,
      insurer_name: `${TEST_PREFIX}insurer`,
      plan_name: TEST_PLAN_NAME,
      plan_year: 2026,
      source: "sbc_upload",
      confidence: 0.5,
    });
    if (ipErr) throw new Error(`insurance_plans insert user ${i + 1}: ${ipErr.message}`);

    const serviceId = i < 2 ? canonicalServiceId : aliasServiceId;
    const fieldProvenance = {
      [FIELD_NAME]: {
        value: COMMON_VALUE,
        source: "sbc_upload",
        confidence: 0.5,
        source_excerpt: `Test excerpt user ${i + 1}: copay $${COMMON_VALUE}`,
        source_excerpt_verified: "verified",
        source_section_verified: true,
        source_section_hint: "common_medical_events",
        last_corroborated_at: new Date().toISOString(),
      },
    };

    const { error: pcsErr } = await supabase.from("plan_covered_services").insert({
      insurance_plan_id: planId,
      service_id: serviceId,
      covered: true,
      in_copay: COMMON_VALUE,
      source: "sbc_parsed",
      confidence: 0.5,
      field_provenance: fieldProvenance,
    });
    if (pcsErr) throw new Error(`plan_covered_services insert user ${i + 1}: ${pcsErr.message}`);
  }

  return { canonicalPlanId, userIds, conceptId };
}

async function run(): Promise<void> {
  await cleanup();
  const { canonicalPlanId } = await setup();

  console.log("\n--- Test 1: evaluate with canonical slug ---");
  const { data: canonicalResult, error: canonicalErr } = await supabase.rpc(
    "evaluate_pattern1_corroboration",
    {
      p_canonical_plan_id: canonicalPlanId,
      p_service_slug: CANONICAL_SLUG,
      p_field_name: FIELD_NAME,
    },
  );
  if (canonicalErr) {
    console.error(`  Error: ${canonicalErr.message}`);
    fail++;
    failures.push("canonical-slug evaluator call failed");
  } else {
    const r = canonicalResult as Record<string, unknown>;
    expect("canonical slug: distinct_user_count = 3", r.distinct_user_count, 3);
    expect("canonical slug: same_value_count = 3", r.same_value_count, 3);
    expect("canonical slug: should_promote = true", r.should_promote, true);
    expect("canonical slug: canonical_service_slug = canonical", r.canonical_service_slug, CANONICAL_SLUG);
    expect("canonical slug: sibling_slugs_count = 2", r.sibling_slugs_count, 2);
    expect("canonical slug: target_table = plan_covered_services", r.target_table, "plan_covered_services");
  }

  console.log("\n--- Test 2: evaluate with ALIAS slug (the load-bearing case) ---");
  const { data: aliasResult, error: aliasErr } = await supabase.rpc(
    "evaluate_pattern1_corroboration",
    {
      p_canonical_plan_id: canonicalPlanId,
      p_service_slug: ALIAS_SLUG,
      p_field_name: FIELD_NAME,
    },
  );
  if (aliasErr) {
    console.error(`  Error: ${aliasErr.message}`);
    fail++;
    failures.push("alias-slug evaluator call failed");
  } else {
    const r = aliasResult as Record<string, unknown>;
    expect("alias slug: distinct_user_count = 3", r.distinct_user_count, 3);
    expect("alias slug: same_value_count = 3", r.same_value_count, 3);
    expect("alias slug: should_promote = true", r.should_promote, true);
    expect(
      "alias slug: canonical_service_slug points to canonical (NOT input alias)",
      r.canonical_service_slug,
      CANONICAL_SLUG,
    );
    expect("alias slug: sibling_slugs_count = 2", r.sibling_slugs_count, 2);
  }

  console.log("\n--- Test 3: evaluate with NONEXISTENT slug (legacy fallthrough) ---");
  const { data: legacyResult, error: legacyErr } = await supabase.rpc(
    "evaluate_pattern1_corroboration",
    {
      p_canonical_plan_id: canonicalPlanId,
      p_service_slug: `${TEST_PREFIX}nonexistent-slug`,
      p_field_name: FIELD_NAME,
    },
  );
  if (legacyErr) {
    console.error(`  Error: ${legacyErr.message}`);
    fail++;
    failures.push("legacy-slug evaluator call failed");
  } else {
    const r = legacyResult as Record<string, unknown>;
    expect("legacy slug: distinct_user_count = 0 (no rows match)", r.distinct_user_count, 0);
    expect("legacy slug: should_promote = false", r.should_promote, false);
    expect(
      "legacy slug: canonical_service_slug falls through to input (no catalog hit)",
      r.canonical_service_slug,
      `${TEST_PREFIX}nonexistent-slug`,
    );
    expect("legacy slug: sibling_slugs_count = 1 (self)", r.sibling_slugs_count, 1);
  }

  await cleanup();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("\nFailures:");
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  process.exit(0);
}

run().catch((err) => {
  console.error("Fatal error:", err);
  cleanup().finally(() => process.exit(1));
});
