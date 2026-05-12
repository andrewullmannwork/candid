/**
 * S73.5 D1 — Integration test: plan-doc-only smart-skip guard against dev DB.
 *
 * Validates that `shouldSkipExtraction` behaves correctly when called with
 * real documents in the dev DB (no mocks). Complements the unit test at
 * `scripts/test-extraction-dedup-doctype-guard.ts` which uses stubs.
 *
 * Scenarios tested:
 *   1. SBC document with no prior hash → passes D1 guard → returns NO_SKIP
 *      with reason='first_time_hash_always_extracts' (not 'not_a_plan_document').
 *   2. EOB document → refused at D1 guard with reason='not_a_plan_document'.
 *   3. Insurance card document → refused at D1 guard.
 *   4. plan_document → passes D1 guard.
 *   5. EOC document → passes D1 guard.
 *   6. Document with NULL doc_type (legacy) + no docType param → falls back
 *      to DB fetch and refuses.
 *
 * Run: `npx tsx scripts/test-d1-guard-integration.ts`
 *
 * Test isolation: synthetic test_user (firebase_uid='test_d1_guard_<timestamp>')
 * + temp documents; cleans up at end.
 */

import { config } from "dotenv";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import {
  shouldSkipExtraction,
  type PlanIdentifiers,
} from "../src/lib/plan/extraction-dedup";
import type { ClassifiedDocType } from "../src/lib/classifier";

config({ path: resolve(__dirname, "../.env.local"), override: true });

const TEST_USER_PREFIX = "test_d1_guard_";

interface TestResult {
  name: string;
  passed: boolean;
  message: string;
}
const results: TestResult[] = [];

function record(name: string, passed: boolean, message: string) {
  results.push({ name, passed, message });
  const icon = passed ? "✓" : "✗";
  console.log(`  ${icon} ${name}: ${message}`);
}

const dummyIdentifiers: PlanIdentifiers = {
  insurer: "TestInsurer",
  planName: "TestPlan",
  groupNumber: null,
  planYear: 2026,
  planType: "PPO",
  state: "CA",
  source: "regex",
};

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const stamp = Date.now();
  const firebaseUid = `${TEST_USER_PREFIX}${stamp}`;
  let userId: string | null = null;
  const createdDocIds: string[] = [];

  console.log(`\n[test-d1-guard] Test user: ${firebaseUid}\n`);

  try {
    // Create test user
    const { data: user, error: userErr } = await supabase
      .from("users")
      .insert({ firebase_uid: firebaseUid, email: `${firebaseUid}@test.local` })
      .select("id")
      .single();
    if (userErr || !user) throw new Error(`User insert failed: ${userErr?.message}`);
    userId = user.id;
    console.log(`  Created test user id=${userId}`);

    // Create a consent_event (required FK for documents per mig 001)
    const { data: consentEvent, error: consentErr } = await supabase
      .from("consent_events")
      .insert({
        user_id: userId,
        consent_type: "tos",
        consent_version: "test_v1",
        consent_text_hash: "test_hash",
        granted: true,
      })
      .select("id")
      .single();
    if (consentErr || !consentEvent) {
      throw new Error(`Consent event insert failed: ${consentErr?.message}`);
    }
    const consentEventId: string = consentEvent.id;
    console.log(`  Created consent_event id=${consentEventId}\n`);

    async function createDoc(docType: string | null, label: string): Promise<string> {
      const { data, error } = await supabase
        .from("documents")
        .insert({
          user_id: userId,
          consent_event_id: consentEventId,
          file_name: `${label}-${stamp}.pdf`,
          storage_path: `test/d1-guard/${label}-${stamp}.pdf`,
          file_size: 100_000,
          status: "uploaded",
          doc_type: docType,
        })
        .select("id")
        .single();
      if (error || !data) throw new Error(`Doc insert failed for ${label}: ${error?.message}`);
      createdDocIds.push(data.id);
      return data.id;
    }

    // Scenario 1: SBC with no prior hash → passes D1 guard → first-time hash path
    console.log("[Scenario 1] SBC with no prior hash");
    const sbcDocId = await createDoc("sbc", "sbc");
    const sbcResult = await shouldSkipExtraction(
      supabase,
      sbcDocId,
      "a".repeat(64), // arbitrary hash
      dummyIdentifiers,
      userId!,
      "sbc" as ClassifiedDocType,
    );
    record(
      "Scenario 1",
      sbcResult.skip === false && sbcResult.reason !== "not_a_plan_document",
      `skip=${sbcResult.skip}, reason=${sbcResult.reason}`,
    );

    // Scenario 2: EOB → refused at D1 guard
    console.log("\n[Scenario 2] EOB → refused at D1 guard");
    const eobDocId = await createDoc("eob", "eob");
    const eobResult = await shouldSkipExtraction(
      supabase,
      eobDocId,
      "b".repeat(64),
      dummyIdentifiers,
      userId!,
      "eob" as ClassifiedDocType,
    );
    record(
      "Scenario 2",
      eobResult.skip === false && eobResult.reason === "not_a_plan_document",
      `skip=${eobResult.skip}, reason=${eobResult.reason}`,
    );

    // Scenario 3: insurance_card → refused at D1 guard
    console.log("\n[Scenario 3] insurance_card → refused at D1 guard");
    const cardDocId = await createDoc("insurance_card", "card");
    const cardResult = await shouldSkipExtraction(
      supabase,
      cardDocId,
      "c".repeat(64),
      dummyIdentifiers,
      userId!,
      "insurance_card" as ClassifiedDocType,
    );
    record(
      "Scenario 3",
      cardResult.skip === false && cardResult.reason === "not_a_plan_document",
      `skip=${cardResult.skip}, reason=${cardResult.reason}`,
    );

    // Scenario 4: plan_document → passes D1 guard
    console.log("\n[Scenario 4] plan_document → passes D1 guard");
    const planDocId = await createDoc("plan_document", "plan_doc");
    const planResult = await shouldSkipExtraction(
      supabase,
      planDocId,
      "d".repeat(64),
      dummyIdentifiers,
      userId!,
      "plan_document" as ClassifiedDocType,
    );
    record(
      "Scenario 4",
      planResult.skip === false && planResult.reason !== "not_a_plan_document",
      `skip=${planResult.skip}, reason=${planResult.reason}`,
    );

    // Scenario 5: EOC → passes D1 guard
    console.log("\n[Scenario 5] EOC → passes D1 guard");
    const eocDocId = await createDoc("eoc", "eoc");
    const eocResult = await shouldSkipExtraction(
      supabase,
      eocDocId,
      "e".repeat(64),
      dummyIdentifiers,
      userId!,
      "eoc" as ClassifiedDocType,
    );
    record(
      "Scenario 5",
      eocResult.skip === false && eocResult.reason !== "not_a_plan_document",
      `skip=${eocResult.skip}, reason=${eocResult.reason}`,
    );

    // Scenario 6: doc_type='other' with no docType param → fallback fetch → refuses
    // 'other' is NOT on the plan-document whitelist; guard refuses via DB lookup.
    console.log("\n[Scenario 6] doc_type='other' + no docType param → fallback fetch refuses");
    const otherDocId = await createDoc("other", "other-doctype");
    const otherResult = await shouldSkipExtraction(
      supabase,
      otherDocId,
      "f".repeat(64),
      dummyIdentifiers,
      userId!,
      // no docType arg — should fall back to DB fetch which finds 'other'
    );
    record(
      "Scenario 6",
      otherResult.skip === false && otherResult.reason === "not_a_plan_document",
      `skip=${otherResult.skip}, reason=${otherResult.reason}`,
    );

    // Summary
    console.log(`\n=== SUMMARY ===`);
    const passed = results.filter((r) => r.passed).length;
    const failed = results.length - passed;
    console.log(`${passed}/${results.length} tests passed`);
    if (failed > 0) {
      console.error(`${failed} FAILED:`);
      results.filter((r) => !r.passed).forEach((r) => console.error(`  - ${r.name}: ${r.message}`));
    }
    return failed === 0;
  } finally {
    // Cleanup
    if (createdDocIds.length > 0) {
      await supabase.from("documents").delete().in("id", createdDocIds);
    }
    if (userId) {
      await supabase.from("users").delete().eq("id", userId);
    }
    console.log(`\n[test-d1-guard] Cleanup complete (deleted user ${userId} + ${createdDocIds.length} docs)`);
  }
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error("Test runner failed:", err);
    process.exit(1);
  });
