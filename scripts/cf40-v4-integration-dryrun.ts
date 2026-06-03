/**
 * Ing-D.0f — CF-40 v4 read-only INTEGRATION dry-run (the Ing-D.1 flip-readiness gate).
 *
 * The single command to run BEFORE advancing any Ing-D.1 rollout stage. It answers:
 * "if the flag were ON over today's PROD data, would v4 REGRESS v3, and do the
 * cross-layer invariants hold?" — without writing anything. Consolidates the Layer-3
 * promotion + Layer-3(b) minority pass (no standalone dry-run exists for these) with the
 * cross-layer invariants + a single PASS/FAIL verdict, then runs the per-layer L1/L4
 * read-only dry-runs under one umbrella.
 *
 * THE no-regression check (the H-risk the Phase-0 audit flagged): no canonical that is
 * CURRENTLY promoted would be UN-promoted by v4. v4 writes are additive (new promotion /
 * divergence rows); it never mutates served canonical_plans values (Pattern 1 #14).
 *
 * NOTE on today's baseline: the Layer-1 contribution gate (D.0b) only counts docs with
 * cf40_layer1_passed=TRUE, which is set ONLY under flag-ON. So while the flag is OFF,
 * 0 PROD parses are L3-evaluable — the L3/L3b portion is vacuously clean and the FIXTURES
 * (cf40-v4-all-fixtures.ts) carry the decision proof. Re-run this during the Ing-D.1
 * admin soak, when flag-ON parses begin passing Layer 1, for a live regression check.
 *
 *   npx tsx scripts/cf40-v4-integration-dryrun.ts
 */

import { config } from "dotenv";
import { resolve } from "path";
import { spawnSync } from "child_process";
import { createClient } from "@supabase/supabase-js";
import {
  gatherLayer3Inputs,
  decideDoctypePromotion,
  buildMinorityReviewRows,
} from "@/lib/parser/cf40-v4/doctype-promotion-aggregator";
import type { PlanDocType } from "@/lib/parser/doctype-expected-counts";

config({ path: resolve(process.cwd(), ".env.local") });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
  { auth: { persistSession: false } },
);

const NOW = new Date();
const DOC_TYPES: PlanDocType[] = ["sbc", "eoc", "plan_document"];
// admin_attestation_enabled is ON in PROD (mig 086 seed) — evaluate the admin path too.
const ADMIN_ATTESTATION_ENABLED = true;

interface Violation {
  kind: string;
  detail: string;
}

async function l3Pass(): Promise<{
  evaluated: number;
  wouldPromote: number;
  wouldRegress: number;
  minorityRows: number;
  violations: Violation[];
}> {
  // Candidates: canonicals with ≥2 distinct uploaders (a promotion/split needs them).
  const { data: planRows, error } = await supabase
    .from("insurance_plans")
    .select("canonical_plan_id, user_id")
    .not("canonical_plan_id", "is", null)
    .limit(100_000);
  if (error) throw new Error(`insurance_plans query: ${error.message}`);
  const usersByCanonical = new Map<string, Set<string>>();
  for (const r of planRows ?? []) {
    const c = r.canonical_plan_id as string;
    (usersByCanonical.get(c) ?? usersByCanonical.set(c, new Set()).get(c)!).add(r.user_id as string);
  }
  const candidates = [...usersByCanonical.entries()].filter(([, u]) => u.size >= 2).map(([c]) => c);

  let evaluated = 0;
  let wouldPromote = 0;
  let wouldRegress = 0;
  let minorityRows = 0;
  const violations: Violation[] = [];

  for (const canonicalId of candidates) {
    for (const docType of DOC_TYPES) {
      const inputs = await gatherLayer3Inputs(supabase, canonicalId, docType, NOW);
      if (!inputs) continue;
      evaluated += 1;

      const { result } = decideDoctypePromotion(inputs, docType, ADMIN_ATTESTATION_ENABLED);
      if (result.promoted) wouldPromote += 1;

      // No-regression check: is this pair CURRENTLY promoted but v4 would NOT promote?
      const { data: cur } = await supabase
        .from("canonical_doctype_promotion_state")
        .select("doctype_promoted")
        .eq("canonical_plan_id", canonicalId)
        .eq("document_type", docType)
        .maybeSingle();
      if (cur?.doctype_promoted === true && !result.promoted) {
        wouldRegress += 1;
        violations.push({
          kind: "promotion_regression",
          detail: `${canonicalId.slice(0, 8)}…|${docType} currently promoted but v4 would NOT promote (${result.failureReasons.join(",")})`,
        });
      }

      // Layer-3(b) minority rows + the router-gate invariant.
      const rows = buildMinorityReviewRows(canonicalId, docType, inputs);
      minorityRows += rows.length;
      if (rows.length > 0) {
        if (!inputs.baselineTuple) {
          violations.push({ kind: "minority_without_baseline", detail: `${canonicalId.slice(0, 8)}…|${docType}` });
        }
        if (inputs.corroboration.distinctPhoneEmailUsers < 2) {
          violations.push({ kind: "minority_below_user_gate", detail: `${canonicalId.slice(0, 8)}…|${docType}` });
        }
      }
    }
  }
  return { evaluated, wouldPromote, wouldRegress, minorityRows, violations };
}

function runDryrun(script: string): { ok: boolean; summary: string } {
  const r = spawnSync("npx", ["tsx", `scripts/${script}`], { encoding: "utf8" });
  const lines = (r.stdout ?? "").trim().split("\n").filter(Boolean);
  // surface the most informative trailing lines
  const summary = lines.slice(-3).join(" | ");
  return { ok: r.status === 0, summary };
}

async function main() {
  console.log("\n══ Ing-D.0f CF-40 v4 INTEGRATION dry-run — READ-ONLY flip-readiness gate ══\n");

  // ── Layer 3 + Layer 3(b) consolidated pass ──
  const l3 = await l3Pass();
  console.log("── Layer 3 promotion + Layer 3(b) minority ──");
  console.log(`(canonical, doc_type) pairs L3-evaluable (Layer-1-passed docs): ${l3.evaluated}`);
  console.log(`v4 would promote: ${l3.wouldPromote}`);
  console.log(`v4 would create minority divergence rows: ${l3.minorityRows}`);
  console.log(`NO-REGRESSION — currently-promoted pairs v4 would UN-promote: ${l3.wouldRegress}`);
  if (l3.evaluated === 0) {
    console.log("  (0 evaluable — expected while flag OFF: the L1 contribution gate excludes");
    console.log("   flag-OFF parses. Fixtures carry the L3/L3b decision proof; re-run in Ing-D.1.)");
  }

  // ── per-layer read-only dry-runs under one umbrella ──
  console.log("\n── per-layer read-only dry-runs ──");
  const layer1 = runDryrun("cf40-v4-layer1-dryrun.ts");
  const slowDrift = runDryrun("cf40-v4-slow-drift-dryrun.ts");
  const rapidVerify = runDryrun("cf40-v4-rapid-verify-dryrun.ts");
  const minority = runDryrun("cf40-v4-minority-dryrun.ts");
  for (const [name, r] of [
    ["layer1", layer1],
    ["slow-drift", slowDrift],
    ["rapid-verify", rapidVerify],
    ["minority", minority],
  ] as const) {
    console.log(`  ${r.ok ? "✅" : "❌"} ${name}: ${r.summary}`);
  }

  // ── invariants + verdict ──
  console.log("\n── cross-layer invariants ──");
  const dryrunOk = layer1.ok && slowDrift.ok && rapidVerify.ok && minority.ok;
  const checks: Array<[string, boolean]> = [
    ["no promotion regressions (currently-promoted → v4 un-promote)", l3.wouldRegress === 0],
    ["every minority row has a baseline + ≥2 verified users", !l3.violations.some((v) => v.kind.startsWith("minority_"))],
    ["all per-layer read-only dry-runs ran clean", dryrunOk],
  ];
  for (const [label, ok] of checks) console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (l3.violations.length) {
    console.log("\n  violations:");
    for (const v of l3.violations.slice(0, 25)) console.log(`    • [${v.kind}] ${v.detail}`);
  }

  const pass = checks.every(([, ok]) => ok);
  console.log(`\n${pass ? "✅ FLIP-READINESS: PASS" : "❌ FLIP-READINESS: FAIL"} — v4 is additive/non-regressing over today's PROD state.\n`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
