/**
 * Ing-D.0b dry-run (Ship Gate G2/G3) — READ-ONLY analysis over PROD rows.
 *
 * No writes, no Haiku calls. Reconstructs the Ing-D.0b decisions from live data
 * to answer two questions BEFORE the flag is ever flipped:
 *
 *   PART 1 — Layer 1 contribution gate selectivity. For recent plan-doc parses,
 *   how many WOULD pass Layer 1 (and thus contribute to stability/coverage) vs be
 *   excluded, and why. Tells us the gate excludes low-quality parses without
 *   over-gating good ones.
 *
 *   PART 2 — Smart-skip conservatism. For stable (canonical, hash) pairs, what the
 *   v4 orchestrator WOULD decide vs what v3 does today. Expected: v4 skips ≈ 0
 *   today (no doc-type promotions yet) → strictly more conservative than v3 until
 *   promotion-state accrues under flag-ON.
 *
 * Run: npx tsx scripts/cf40-v4-layer1-dryrun.ts
 */

import { config } from "dotenv";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import {
  evaluateValidityGates,
  resolveTrustTier,
  STABILITY_THRESHOLD,
  type ValidityGateInput,
} from "@/lib/parser/cf40-v4";
import { toPlanDocType } from "@/lib/parser/doctype-expected-counts";

config({ path: resolve(process.cwd(), ".env.local") });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
  { auth: { persistSession: false } },
);

const NOW = new Date();
const PLAN_DOC_TYPES = ["sbc", "eoc", "plan_document"];

type Prov = Record<string, { source_excerpt_verified?: string } | undefined> | null;

function deriveSelfCheckPassRate(fp: Prov): number | null {
  if (!fp) return null;
  const entries = Object.values(fp).filter((e) => e?.source_excerpt_verified !== undefined);
  if (entries.length === 0) return null;
  const verified = entries.filter((e) => e?.source_excerpt_verified === "verified").length;
  return verified / entries.length;
}

function inc(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

async function part1Layer1Selectivity() {
  console.log("\n══ PART 1 — Layer 1 contribution-gate selectivity (recent plan-doc parses) ══\n");

  const { data: docs } = await supabase
    .from("documents")
    .select("id, classified_type, classification_confidence, file_size, plan_year, created_at, linked_insurance_plan_id, user_id")
    .in("classified_type", PLAN_DOC_TYPES)
    .eq("status", "processed")
    .not("linked_insurance_plan_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(500);

  if (!docs || docs.length === 0) {
    console.log("  (no processed plan-doc documents found — DB likely wiped post user-test; gate selectivity not measurable on PROD today)");
    return;
  }

  const planIds = [...new Set(docs.map((d) => d.linked_insurance_plan_id as string))];
  const { data: plans } = await supabase
    .from("insurance_plans")
    .select("id, field_provenance, canonical_plan_id")
    .in("id", planIds);
  const planById = new Map((plans ?? []).map((p) => [p.id as string, p]));

  const firebaseUids = [...new Set(docs.map((d) => d.user_id as string))];
  const { data: users } = await supabase
    .from("users")
    .select("firebase_uid, is_admin, email_verified, phone_verified")
    .in("firebase_uid", firebaseUids);
  const userByUid = new Map((users ?? []).map((u) => [u.firebase_uid as string, u]));

  const passReasons = new Map<string, number>();
  const failReasons = new Map<string, number>();
  let pass = 0;
  let fail = 0;
  let selfCheckPresent = 0;
  let selfCheckNull = 0;
  let classPresent = 0;
  let classNull = 0;

  for (const d of docs) {
    const planDocType = toPlanDocType(d.classified_type as string);
    if (!planDocType) continue;
    const plan = planById.get(d.linked_insurance_plan_id as string);
    const u = userByUid.get(d.user_id as string);
    const selfCheck = deriveSelfCheckPassRate((plan?.field_provenance ?? null) as Prov);
    const classConf = (d.classification_confidence as number | null) ?? null;
    if (selfCheck === null) selfCheckNull++; else selfCheckPresent++;
    if (classConf === null) classNull++; else classPresent++;

    const input: ValidityGateInput = {
      selfCheckPassRate: selfCheck,
      ocrConfidence: null, // not plumbed (matches live)
      classificationConfidence: classConf,
      uploadedAt: (d.created_at as string | null) ?? NOW.toISOString(),
      documentPlanYear: (d.plan_year as number | null) ?? null,
      fileSizeBytes: (d.file_size as number | null) ?? 0,
      docType: planDocType,
      uploaderTier: resolveTrustTier({
        isAdmin: u?.is_admin === true,
        phoneVerified: u?.phone_verified === true,
        emailVerified: u?.email_verified === true,
      }),
      isAdmin: u?.is_admin === true,
      isBanned: false,
      canonicalReBaselineRequired: false, // promotion-state ~empty pre-flag; treated false
    };
    const r = evaluateValidityGates(input);
    if (r.pass) {
      pass++;
      inc(passReasons, planDocType);
    } else {
      fail++;
      for (const reason of r.failureReasons) inc(failReasons, reason);
    }
  }

  const n = pass + fail;
  console.log(`  Analyzed ${n} recent plan-doc parses.`);
  console.log(`  Layer 1 PASS (would contribute): ${pass} (${((pass / n) * 100).toFixed(1)}%)`);
  console.log(`  Layer 1 FAIL (excluded):         ${fail} (${((fail / n) * 100).toFixed(1)}%)`);
  console.log(`  PASS by doc-type: ${[...passReasons].map(([k, v]) => `${k}=${v}`).join(", ") || "—"}`);
  console.log(`  FAIL by reason:   ${[...failReasons].map(([k, v]) => `${k}=${v}`).join(", ") || "—"}`);
  console.log(`  Signal availability — self-check: present=${selfCheckPresent} null=${selfCheckNull}; classification: present=${classPresent} null=${classNull}`);
  console.log("\n  BEFORE (D.0a): ALL of these parses contributed weight + coverage (ungated).");
  console.log(`  AFTER (D.0b):  only the ${pass} Layer-1-passing parses contribute; ${fail} excluded.`);
}

async function part2SkipConservatism() {
  console.log("\n══ PART 2 — Smart-skip conservatism (stable canonical/hash pairs) ══\n");

  const { data: stab } = await supabase
    .from("canonical_document_stability")
    .select("canonical_plan_id, file_hash, haiku_output_stable, parse_weight_accumulated, smart_skip_count, last_full_parse_at")
    .limit(1000);

  if (!stab || stab.length === 0) {
    console.log("  (no canonical_document_stability rows — nothing skip-eligible; v4 + v3 both extract everything)");
    return;
  }

  const { data: promo } = await supabase
    .from("canonical_doctype_promotion_state")
    .select("canonical_plan_id, document_type, doctype_promoted")
    .eq("doctype_promoted", true);
  const promotedCanonicals = new Set((promo ?? []).map((p) => p.canonical_plan_id as string));

  const v3SkipCount = stab.filter((s) => s.haiku_output_stable === true).length;
  const layer2StableCount = stab.filter(
    (s) => ((s.parse_weight_accumulated as number | null) ?? 0) >= STABILITY_THRESHOLD,
  ).length;
  // v4 structural skip-eligible upper bound: layer2 stable AND its canonical has a
  // doc-type promotion (Layer 3) AND not force-sampled. We measure layer2∧layer3.
  const v4StructuralEligible = stab.filter(
    (s) =>
      ((s.parse_weight_accumulated as number | null) ?? 0) >= STABILITY_THRESHOLD &&
      promotedCanonicals.has(s.canonical_plan_id as string),
  ).length;

  console.log(`  Stable rows examined:                 ${stab.length}`);
  console.log(`  v3 would SKIP (haiku_output_stable):  ${v3SkipCount}`);
  console.log(`  Layer 2 stable (Σweight ≥ ${STABILITY_THRESHOLD}):        ${layer2StableCount}`);
  console.log(`  Doc-type promotions (Layer 3) total:  ${(promo ?? []).length}`);
  console.log(`  v4 structural skip-eligible (L2∧L3):  ${v4StructuralEligible}`);
  console.log("\n  BEFORE (v3): skips on haiku_output_stable alone.");
  console.log("  AFTER (v4):  skip requires L1(upload)∧L2(weight≥3)∧L3(promoted)∧¬L5(forced).");
  console.log(`  → v4 skip-eligible today = ${v4StructuralEligible} (promotion-state accrues only under flag-ON) ⇒ v4 is strictly MORE conservative than v3 pre-rollout.`);
}

async function main() {
  console.log("CF-40 v4 Ing-D.0b — read-only dry-run (no writes, no Haiku)");
  await part1Layer1Selectivity();
  await part2SkipConservatism();
  console.log("\nDone.");
}

main().catch((e) => {
  console.error("dry-run error:", e);
  process.exit(1);
});
