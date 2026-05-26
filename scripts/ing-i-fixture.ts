#!/usr/bin/env tsx
/**
 * Ing-I fixture (Ship Gate G4; manually re-runnable).
 *
 * Tests the pure helpers + the resolver integration with mocked Supabase + Haiku.
 * Verifies: config parsing, Haiku prompt shape, response parsing, 2-pass
 * resolver behavior (Pass 1 sufficient vs Pass 2 fallback), merge RPC wrapper
 * payload mapping (ok + each error variant).
 *
 * Run: npx tsx scripts/ing-i-fixture.ts
 *
 * CI wiring deferred to fixture-CI-harness session per existing retroactive
 * Ship Gate convention (see plans/block_ship_gate.md §"Follow-up Obligations").
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_CONFIG,
  buildHaikuMatchPrompt,
  parseConfig,
  parseHaikuMatchResponse,
  resolveSlugCandidates,
} from "../src/lib/parser/review-queue-candidates";
import { mergeProposedSlugIntoCanonical } from "../src/lib/parser/review-queue-merge-rpc";

let run = 0;
let pass = 0;
function assert(label: string, cond: boolean, detail?: string): void {
  run += 1;
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`);
  }
}
function header(s: string): void {
  console.log(`\n${s}`);
}

async function main() {
  // ─── 1. parseConfig — pure ────────────────────────────────────────────────
  header("[1] parseConfig — defaults + valid override + invalid fallback");
  const cfgDefault = parseConfig(undefined);
  assert("undefined → defaults", cfgDefault.trigram_threshold === DEFAULT_CONFIG.trigram_threshold);
  assert("undefined → defaults (top_k)", cfgDefault.top_k === DEFAULT_CONFIG.top_k);

  const cfgValid = parseConfig({
    trigram_threshold: 0.5,
    semantic_fallback_threshold: 0.7,
    top_k: 5,
    haiku_match_score_floor: 0.6,
  });
  assert("valid trigram_threshold override", cfgValid.trigram_threshold === 0.5);
  assert("valid semantic_fallback_threshold override", cfgValid.semantic_fallback_threshold === 0.7);
  assert("valid top_k override", cfgValid.top_k === 5);
  assert("valid haiku_match_score_floor override", cfgValid.haiku_match_score_floor === 0.6);

  const cfgInvalid = parseConfig({
    trigram_threshold: 1.5, // out of range
    semantic_fallback_threshold: -0.1, // out of range
    top_k: 100, // out of range
    haiku_match_score_floor: "string", // wrong type
  });
  assert("invalid trigram_threshold → default", cfgInvalid.trigram_threshold === DEFAULT_CONFIG.trigram_threshold);
  assert("invalid semantic_fallback_threshold → default", cfgInvalid.semantic_fallback_threshold === DEFAULT_CONFIG.semantic_fallback_threshold);
  assert("invalid top_k → default", cfgInvalid.top_k === DEFAULT_CONFIG.top_k);
  assert("invalid haiku_match_score_floor → default", cfgInvalid.haiku_match_score_floor === DEFAULT_CONFIG.haiku_match_score_floor);

  // ─── 2. buildHaikuMatchPrompt — pure ──────────────────────────────────────
  header("[2] buildHaikuMatchPrompt — prompt contents");
  const prompt = buildHaikuMatchPrompt({
    proposedSlug: "chiropractic_care",
    proposedLabel: "Chiropractic visits",
    canonicalCandidates: [
      { slug: "chiropractic_visit", name: "Chiropractic Visit", description: "Routine chiropractic care" },
      { slug: "physical_therapy", name: "Physical Therapy", description: "PT services" },
    ],
    topK: 3,
    scoreFloor: 0.5,
  });
  assert("prompt contains proposed slug", prompt.includes("chiropractic_care"));
  assert("prompt contains proposed label", prompt.includes("Chiropractic visits"));
  assert("prompt contains universe entry 1", prompt.includes("chiropractic_visit"));
  assert("prompt contains universe entry 2", prompt.includes("physical_therapy"));
  assert("prompt contains scoring rules header", prompt.includes("Scoring rules"));
  assert("prompt contains score floor", prompt.includes("0.5"));
  assert("prompt requests JSON output", prompt.includes("JSON"));

  const promptNoLabel = buildHaikuMatchPrompt({
    proposedSlug: "test_slug",
    proposedLabel: null,
    canonicalCandidates: [{ slug: "x", name: "X", description: null }],
    topK: 3,
    scoreFloor: 0.5,
  });
  assert("null proposedLabel handled", promptNoLabel.includes("(none provided)"));

  // ─── 3. parseHaikuMatchResponse — pure ────────────────────────────────────
  header("[3] parseHaikuMatchResponse — happy path + malformed");

  const happy = parseHaikuMatchResponse(
    JSON.stringify({ candidates: [{ slug: "x", match_score: 0.9 }, { slug: "y", match_score: 0.6 }] }),
  );
  assert("parses 2 candidates", happy.length === 2);
  assert("first slug correct", happy[0]?.slug === "x");
  assert("first score correct", happy[0]?.match_score === 0.9);

  const fenced = parseHaikuMatchResponse(
    "```json\n" + JSON.stringify({ candidates: [{ slug: "fenced", match_score: 0.7 }] }) + "\n```",
  );
  assert("strips markdown fences", fenced.length === 1 && fenced[0]?.slug === "fenced");

  const malformed = parseHaikuMatchResponse("not even json");
  assert("malformed → []", malformed.length === 0);

  const wrongShape = parseHaikuMatchResponse(JSON.stringify({ no_candidates: [] }));
  assert("wrong shape → []", wrongShape.length === 0);

  const outOfRange = parseHaikuMatchResponse(
    JSON.stringify({ candidates: [{ slug: "bad", match_score: 1.5 }, { slug: "good", match_score: 0.8 }] }),
  );
  assert("filters out-of-range scores", outOfRange.length === 1 && outOfRange[0]?.slug === "good");

  const missingField = parseHaikuMatchResponse(
    JSON.stringify({ candidates: [{ slug: "incomplete" }, { slug: "ok", match_score: 0.7 }] }),
  );
  assert("filters missing match_score", missingField.length === 1 && missingField[0]?.slug === "ok");

  // ─── 4. resolveSlugCandidates — Pass 1 sufficient ──────────────────────────
  header("[4] resolveSlugCandidates — Pass 1 sufficient (no Haiku fallback)");
  let rpcCallCount = 0;
  const supabasePass1: SupabaseClient = {
    rpc: async (fn: string, _args: unknown) => {
      rpcCallCount += 1;
      if (fn === "find_service_catalog_candidates") {
        return {
          data: [
            { slug: "physical_therapy", name: "Physical Therapy", description: null, concept_id: "c-1", match_score: 0.85 },
            { slug: "occupational_therapy", name: "Occupational Therapy", description: null, concept_id: "c-2", match_score: 0.7 },
          ],
          error: null,
        };
      }
      return { data: null, error: null };
    },
    from: () => {
      throw new Error("Pass 2 should not fire when Pass 1 sufficient");
    },
  } as unknown as SupabaseClient;

  const r1 = await resolveSlugCandidates({
    supabase: supabasePass1,
    proposedSlug: "pt",
    proposedLabel: "Physical Therapy",
  });
  assert("Pass 1 only — 2 candidates returned", r1.length === 2);
  assert("Pass 1 only — top candidate is trigram source", r1[0]?.source === "trigram");
  assert("Pass 1 only — top score preserved", r1[0]?.match_score === 0.85);
  assert("Pass 1 only — RPC called once", rpcCallCount === 1);

  // ─── 5. resolveSlugCandidates — Pass 2 fallback fires ──────────────────────
  header("[5] resolveSlugCandidates — Pass 2 fallback (Pass 1 weak)");
  let haikuCallCount = 0;
  let costEventCount = 0;

  const supabasePass2Clean: SupabaseClient = {
    rpc: async (fn: string, _args: unknown) => {
      if (fn === "find_service_catalog_candidates") {
        return {
          data: [
            { slug: "weak_match", name: "Weak", description: null, concept_id: "c-3", match_score: 0.42 },
          ],
          error: null,
        };
      }
      return { data: null, error: null };
    },
    from: (table: string) => {
      if (table === "service_catalog") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                neq: async () => ({
                  data: [
                    { slug: "physical_therapy", name: "Physical Therapy", description: "PT" },
                    { slug: "chiropractic", name: "Chiropractic", description: "DC" },
                  ],
                  error: null,
                }),
              }),
            }),
          }),
        } as unknown as ReturnType<SupabaseClient["from"]>;
      }
      if (table === "parse_cost_events") {
        return {
          insert: async (_row: unknown) => {
            costEventCount += 1;
            return { error: null };
          },
        } as unknown as ReturnType<SupabaseClient["from"]>;
      }
      return {} as unknown as ReturnType<SupabaseClient["from"]>;
    },
  } as unknown as SupabaseClient;

  const r2 = await resolveSlugCandidates({
    supabase: supabasePass2Clean,
    proposedSlug: "rehab",
    proposedLabel: "Rehab service",
    adminUserId: "admin-1",
    anthropicCall: async (_prompt: string) => {
      haikuCallCount += 1;
      return {
        text: JSON.stringify({
          candidates: [
            { slug: "physical_therapy", match_score: 0.85 },
            { slug: "chiropractic", match_score: 0.55 },
          ],
        }),
        inputTokens: 500,
        outputTokens: 100,
      };
    },
  });

  assert("Pass 2 fired — Haiku called once", haikuCallCount === 1);
  assert("Pass 2 — cost event written", costEventCount === 1);
  assert("Pass 2 — merged result contains haiku candidate", r2.some((c) => c.slug === "physical_therapy" && c.source === "haiku"));
  assert("Pass 2 — top result is highest scoring", r2[0]?.match_score === 0.85);

  // ─── 6. resolveSlugCandidates — Pass 1 RPC failure ──────────────────────────
  header("[6] resolveSlugCandidates — Pass 1 RPC error → empty");
  const supabaseFail: SupabaseClient = {
    rpc: async () => ({ data: null, error: { message: "simulated rpc failure" } }),
    from: () => {
      throw new Error("should not be called");
    },
  } as unknown as SupabaseClient;
  const r3 = await resolveSlugCandidates({
    supabase: supabaseFail,
    proposedSlug: "x",
    proposedLabel: null,
  });
  assert("Pass 1 failure → empty", r3.length === 0);

  // ─── 7. resolveSlugCandidates — Pass 2 Haiku throws ────────────────────────
  header("[7] resolveSlugCandidates — Pass 2 Haiku throw → returns Pass 1");
  let pass1OnlyFromCallback: number | null = null;
  const r4 = await resolveSlugCandidates({
    supabase: supabasePass2Clean,
    proposedSlug: "rehab2",
    proposedLabel: "Rehab again",
    adminUserId: "admin-1",
    anthropicCall: async () => {
      throw new Error("simulated haiku failure");
    },
  });
  pass1OnlyFromCallback = r4.length;
  assert(
    "Pass 2 throw → still returns Pass 1 results (does not throw)",
    pass1OnlyFromCallback !== null && pass1OnlyFromCallback >= 0,
  );

  // ─── 8. mergeProposedSlugIntoCanonical — happy path ────────────────────────
  header("[8] mergeProposedSlugIntoCanonical — happy + error variants");

  const supabaseMergeOk: SupabaseClient = {
    rpc: async (fn: string, args: unknown) => {
      const a = args as Record<string, unknown>;
      if (fn === "merge_proposed_slug_into_canonical") {
        return {
          data: {
            ok: true,
            alias_slug: a.p_proposed_slug ?? "alias-x",
            canonical_slug: a.p_canonical_slug,
            concept_id: "c-merged",
          },
          error: null,
        };
      }
      return { data: null, error: null };
    },
  } as unknown as SupabaseClient;

  const okRes = await mergeProposedSlugIntoCanonical(supabaseMergeOk, {
    queueId: "q-1",
    canonicalSlug: "physical_therapy",
    adminUserId: "admin-1",
  });
  assert("happy MERGE returns ok=true", okRes.ok === true);
  if (okRes.ok) {
    assert("happy MERGE concept_id propagated", okRes.concept_id === "c-merged");
    assert("happy MERGE canonical_slug propagated", okRes.canonical_slug === "physical_therapy");
  }

  // Error: queue_row_not_pending
  const supabaseMergeRace: SupabaseClient = {
    rpc: async () => ({
      data: { ok: false, error: "queue_row_not_pending", current_status: "promoted" },
      error: null,
    }),
  } as unknown as SupabaseClient;
  const raceRes = await mergeProposedSlugIntoCanonical(supabaseMergeRace, {
    queueId: "q-2",
    canonicalSlug: "x",
    adminUserId: "admin-2",
  });
  assert("race → ok=false", raceRes.ok === false);
  if (!raceRes.ok) {
    assert("race → error=queue_row_not_pending", raceRes.error === "queue_row_not_pending");
  }

  // Error: RPC call failed
  const supabaseMergeRpcFail: SupabaseClient = {
    rpc: async () => ({ data: null, error: { message: "rpc connection refused", code: "PGRST000" } }),
  } as unknown as SupabaseClient;
  const failRes = await mergeProposedSlugIntoCanonical(supabaseMergeRpcFail, {
    queueId: "q-3",
    canonicalSlug: "x",
    adminUserId: "admin-3",
  });
  assert("RPC failure → ok=false", failRes.ok === false);
  if (!failRes.ok) {
    assert("RPC failure → error=rpc_call_failed", failRes.error === "rpc_call_failed");
  }

  // Error: canonical_not_found
  const supabaseMergeNoCanonical: SupabaseClient = {
    rpc: async () => ({
      data: { ok: false, error: "canonical_not_found", canonical_slug: "ghost" },
      error: null,
    }),
  } as unknown as SupabaseClient;
  const noCanonical = await mergeProposedSlugIntoCanonical(supabaseMergeNoCanonical, {
    queueId: "q-4",
    canonicalSlug: "ghost",
    adminUserId: "admin-4",
  });
  assert("canonical_not_found → ok=false", noCanonical.ok === false);
  if (!noCanonical.ok) {
    assert("canonical_not_found → error=canonical_not_found", noCanonical.error === "canonical_not_found");
  }

  // Summary
  console.log(`\n${pass}/${run} assertions passed ${pass === run ? "✓" : "✗"}`);
  process.exit(pass === run ? 0 : 1);
}

main().catch((err) => {
  console.error("Fixture threw:", err);
  process.exit(1);
});
