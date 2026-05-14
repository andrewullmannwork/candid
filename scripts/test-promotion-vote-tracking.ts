/**
 * Acceptance test: S74.5c §1.1 per-slug vote tracking.
 *
 * Verifies that the apply_corrector_upsert RPC + evaluateMappingPromotion
 * Pattern 1 #3 evaluator correctly:
 *   (a) DO NOT promote when 3 distinct users vote for 3 different slugs
 *   (b) DO promote when 3 distinct users vote for the SAME slug
 *   (c) DO NOT promote when 2 users agree + 1 disagrees (top vote < threshold)
 *   (d) parser-path bill_observed entries count toward distinct_user_count
 *       but never cast slug votes
 *
 * Runs against the DEV DB. Inserts + cleans up its own fixture rows.
 *
 * Usage:
 *   npx tsx scripts/test-promotion-vote-tracking.ts
 *
 * Exits 0 on success, 1 on failure.
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "path";
import * as crypto from "crypto";

config({ path: resolve(__dirname, "../.env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const FIXTURE_CODE = "99999_TEST";
const FIXTURE_CODE_TYPE = "CPT";
const FIXTURE_SIGNATURE = `s74_5c_vote_test_${Date.now()}`;

function userHash(seed: string, identityId: string): string {
  return crypto.createHash("sha256").update(`${seed}:${identityId}`).digest("hex");
}

async function setupIdentityRow(): Promise<string> {
  const { data, error } = await supabase
    .from("billing_code_identity")
    .insert({
      billing_code: FIXTURE_CODE,
      billing_code_type: FIXTURE_CODE_TYPE,
      description_signature: FIXTURE_SIGNATURE,
      description_examples: ["test fixture"],
      service_slug: null,
      promotion_state: "proposed",
      confidence: 0.5,
      distinct_user_count: 0,
      proposed_by_user_id: null,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`fixture insert failed: ${error?.message}`);
  }
  return data.id as string;
}

async function cleanupIdentityRow(identityId: string) {
  await supabase
    .from("mapping_promotion_events")
    .delete()
    .eq("billing_code_identity_id", identityId);
  await supabase
    .from("billing_code_identity")
    .delete()
    .eq("id", identityId);
}

async function resetIdentityRow(identityId: string) {
  await supabase
    .from("billing_code_identity")
    .update({
      corroborator_sources: [],
      distinct_user_count: 0,
      service_slug: null,
      promotion_state: "proposed",
      confidence: 0.5,
    })
    .eq("id", identityId);
  await supabase
    .from("mapping_promotion_events")
    .delete()
    .eq("billing_code_identity_id", identityId);
}

async function vote(
  identityId: string,
  userSeed: string,
  proposedSlug: string | null,
  source: "user_correction" | "bill_observed" = "user_correction",
) {
  const { error } = await supabase.rpc("apply_corrector_upsert", {
    p_identity_id: identityId,
    p_user_id_hash: userHash(userSeed, identityId),
    p_proposed_slug: proposedSlug,
    p_source: source,
    p_raw_description: `test raw for ${userSeed}`,
    p_claim_line_item_id: null,
  });
  if (error) throw new Error(`apply_corrector_upsert failed: ${error.message}`);
}

interface RowSnapshot {
  service_slug: string | null;
  promotion_state: string;
  distinct_user_count: number;
}

async function readRow(identityId: string): Promise<RowSnapshot> {
  const { data, error } = await supabase
    .from("billing_code_identity")
    .select("service_slug, promotion_state, distinct_user_count")
    .eq("id", identityId)
    .single();
  if (error || !data) throw new Error(`row read failed: ${error?.message}`);
  return {
    service_slug: data.service_slug as string | null,
    promotion_state: data.promotion_state as string,
    distinct_user_count: data.distinct_user_count as number,
  };
}

// Import the evaluator. tsx will resolve the TS path at runtime.
import { evaluateMappingPromotion } from "../src/lib/parser/code-identity-promotion";

interface Assertion {
  name: string;
  ok: boolean;
  detail: string;
}

const results: Assertion[] = [];
function expect(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}: ${detail}`);
}

async function main() {
  console.log("[test] setting up fixture row");
  const identityId = await setupIdentityRow();

  try {
    // ----- Case (a) — 3 different slugs -----
    console.log("\n[test] Case (a): 3 distinct users, 3 different slugs");
    await vote(identityId, "userA", "pcp_visit");
    await vote(identityId, "userB", "annual_physical");
    await vote(identityId, "userC", "preventive_care");

    let row = await readRow(identityId);
    expect(
      "(a) distinct_user_count = 3 after 3 distinct voters",
      row.distinct_user_count === 3,
      `got ${row.distinct_user_count}`,
    );
    expect(
      "(a) service_slug stays null pre-promotion (apply_corrector_upsert never sets slug)",
      row.service_slug === null,
      `got ${JSON.stringify(row.service_slug)}`,
    );

    let evaluation = await evaluateMappingPromotion(identityId, null, "test");
    expect(
      "(a) promotion does NOT fire on slug disagreement",
      evaluation.promoted === false,
      `reason=${evaluation.reason}`,
    );
    expect(
      "(a) evaluator reports slug_disagreement reason",
      evaluation.reason.startsWith("slug_disagreement") ||
        evaluation.reason.startsWith("below_threshold"),
      `reason=${evaluation.reason}`,
    );

    // ----- Case (b) — 3 users vote for same slug -----
    console.log("\n[test] Case (b): 3 distinct users vote SAME slug");
    await resetIdentityRow(identityId);
    await vote(identityId, "userD", "pcp_visit");
    await vote(identityId, "userE", "pcp_visit");
    await vote(identityId, "userF", "pcp_visit");

    row = await readRow(identityId);
    expect(
      "(b) distinct_user_count = 3 after 3 voters agree",
      row.distinct_user_count === 3,
      `got ${row.distinct_user_count}`,
    );
    expect(
      "(b) service_slug still null PRE-evaluator (advisory: apply_corrector_upsert doesn't set slug)",
      row.service_slug === null,
      `got ${JSON.stringify(row.service_slug)}`,
    );

    evaluation = await evaluateMappingPromotion(identityId, null, "test");
    expect(
      "(b) promotion FIRES with 3 votes for same slug",
      evaluation.promoted === true,
      `reason=${evaluation.reason}, winning=${evaluation.promotedSlug}, count=${evaluation.winningVoteCount}`,
    );
    expect(
      "(b) winning slug = pcp_visit",
      evaluation.promotedSlug === "pcp_visit",
      `got ${evaluation.promotedSlug}`,
    );

    row = await readRow(identityId);
    expect(
      "(b) service_slug now set to winning slug POST-promotion",
      row.service_slug === "pcp_visit",
      `got ${JSON.stringify(row.service_slug)}`,
    );
    expect(
      "(b) promotion_state advanced to corroborated",
      row.promotion_state === "corroborated",
      `got ${row.promotion_state}`,
    );

    // ----- Case (c) — 2 same + 1 different -----
    console.log("\n[test] Case (c): 2 votes for X + 1 vote for Y");
    await resetIdentityRow(identityId);
    await vote(identityId, "userG", "pcp_visit");
    await vote(identityId, "userH", "pcp_visit");
    await vote(identityId, "userI", "annual_physical");

    row = await readRow(identityId);
    expect(
      "(c) distinct_user_count = 3",
      row.distinct_user_count === 3,
      `got ${row.distinct_user_count}`,
    );

    evaluation = await evaluateMappingPromotion(identityId, null, "test");
    expect(
      "(c) promotion does NOT fire (max vote = 2 < threshold 3)",
      evaluation.promoted === false,
      `reason=${evaluation.reason}, winning=${evaluation.winningVoteCount}`,
    );
    expect(
      "(c) winningVoteCount = 2",
      evaluation.winningVoteCount === 2,
      `got ${evaluation.winningVoteCount}`,
    );

    // ----- Case (d) — bill_observed don't cast votes -----
    console.log("\n[test] Case (d): 3 bill_observed entries count toward distinct_user_count but cast no slug votes");
    await resetIdentityRow(identityId);
    await vote(identityId, "userJ", null, "bill_observed");
    await vote(identityId, "userK", null, "bill_observed");
    await vote(identityId, "userL", null, "bill_observed");

    row = await readRow(identityId);
    expect(
      "(d) distinct_user_count = 3 from 3 bill_observed entries",
      row.distinct_user_count === 3,
      `got ${row.distinct_user_count}`,
    );

    evaluation = await evaluateMappingPromotion(identityId, null, "test");
    expect(
      "(d) promotion does NOT fire on 0 slug votes",
      evaluation.promoted === false,
      `reason=${evaluation.reason}`,
    );
    expect(
      "(d) evaluator reports no_slug_votes reason",
      evaluation.reason === "no_slug_votes" ||
        evaluation.reason.startsWith("below_threshold"),
      `reason=${evaluation.reason}`,
    );

    // ----- Cleanup -----
    console.log("\n[test] cleaning up fixture");
  } finally {
    await cleanupIdentityRow(identityId);
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n──────── Summary ────────`);
  console.log(`assertions: ${results.length}`);
  console.log(`failed:     ${failed}`);
  console.log(`──────────────────────────`);
  process.exit(failed > 0 ? 1 : 0);
}

void main().catch((err) => {
  console.error("[test] unexpected error:", err);
  process.exit(1);
});
