/**
 * S93 — diagnostic diff for ambetter-silver-87 regression.
 *
 * S92 head-to-head measured: SBC parser baseline 100% on this fixture vs
 * plan_doc parser 95.2% (-4.8pts). The harness reports counts but not WHICH
 * fields regressed; this script runs both parsers on the same fixture and
 * dumps per-field + per-service Pattern P-8 verified status side-by-side so
 * we can target the prompt tweak precisely.
 *
 * Cost: ~$0.30 (one full plan_doc run + one full SBC parser run on
 * the silver-87 fixture, both with snapshot caching).
 *
 * Run: npx tsx scripts/s93-diff-silver87.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
import * as fs from "fs";
config({ path: resolve(__dirname, "../.env.local"), override: true });
import { parsePlanDocumentHaiku } from "../src/lib/plan_doc/parser";
import { votedParseSBC } from "../src/lib/sbc/voted-parser";

const FIXTURE_PATH = "tests/fixtures/sbcs/ambetter-ca-2024-silver-87/source.txt";

async function main() {
  const ocrText = fs.readFileSync(FIXTURE_PATH, "utf-8");
  console.log(`Loaded fixture: ${FIXTURE_PATH} (${ocrText.length} chars)`);

  console.log("\n=== Running plan_doc parser (Haiku-first, federal-SBC supplement active) ===");
  const planDocResult = await parsePlanDocumentHaiku({
    ocrText,
    documentId: "diag_silver87_plandoc",
    extractionMethod: "pdftotext",
  });
  console.log(`plan_doc: ${planDocResult.services.length} services; cost $${planDocResult.costUsd.toFixed(4)}`);

  console.log("\n=== Running SBC parser (legacy Haiku-first SBC) ===");
  const sbcResult = await votedParseSBC({
    ocrText,
    extractionMethod: "pdftotext",
    canonicalMatchExists: false,
    enqueueContext: undefined as unknown as Parameters<typeof votedParseSBC>[0]["enqueueContext"],
  });
  console.log(`sbc: ${sbcResult.services.length} services; cost $${sbcResult.costUsd.toFixed(4)}`);

  // Plan identity diff
  console.log("\n\n========== PLAN IDENTITY DIFF ==========");
  const planDocPI = planDocResult.planIdentity;
  // sbcResult.planIdentity has different shape; map it for comparison
  const sbcPI = sbcResult.planIdentity;
  const planIdentityKeys = [
    "planName",
    "insurerName",
    "planType",
    "planYear",
    "deductibleIndividual",
    "deductibleFamily",
    "oopMaxIndividual",
    "oopMaxFamily",
    "outDeductibleIndividual",
    "outDeductibleFamily",
    "outOopMaxIndividual",
    "outOopMaxFamily",
  ];
  console.log(
    `${"FIELD".padEnd(28)} ${"PLAN_DOC val".padEnd(20)} ${"PLAN_DOC verified".padEnd(20)} ${"SBC val".padEnd(20)} ${"SBC verified".padEnd(20)}`,
  );
  for (const k of planIdentityKeys) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pdField = (planDocPI as any)[k];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sbcField = (sbcPI as any)[k];
    const pdVal = pdField?.value ?? "—";
    const pdVer = pdField?.patternP8?.source_excerpt_verified ?? "—";
    const sbcVal = sbcField?.value ?? "—";
    const sbcVer = sbcField?.patternP8?.source_excerpt_verified ?? "—";
    const flag =
      pdVer !== sbcVer || String(pdVal) !== String(sbcVal) ? "  <-- DIFF" : "";
    console.log(
      `${k.padEnd(28)} ${String(pdVal).padEnd(20).slice(0, 20)} ${String(pdVer).padEnd(20)} ${String(sbcVal).padEnd(20).slice(0, 20)} ${String(sbcVer).padEnd(20)} ${flag}`,
    );
  }

  // Services diff — slug-by-slug
  console.log("\n\n========== SERVICES DIFF (by slug) ==========");
  const planDocBySlug = new Map(planDocResult.services.map((s) => [s.serviceSlug, s]));
  const sbcBySlug = new Map(sbcResult.services.map((s) => [s.serviceSlug, s]));
  const allSlugs = new Set<string>();
  planDocBySlug.forEach((_, k) => allSlugs.add(k));
  sbcBySlug.forEach((_, k) => allSlugs.add(k));
  console.log(`Total unique slugs across both parsers: ${allSlugs.size}`);
  console.log(
    `${"SLUG".padEnd(36)} ${"PD inCost".padEnd(22)} ${"PD verified".padEnd(14)} ${"SBC inCost".padEnd(22)} ${"SBC verified".padEnd(14)}`,
  );
  const sortedSlugs = Array.from(allSlugs).sort();
  for (const slug of sortedSlugs) {
    const pd = planDocBySlug.get(slug);
    const sbc = sbcBySlug.get(slug);
    const pdInCost = pd?.inCostDescription ?? "—";
    const pdVerified =
      pd?.patternP8?.source_excerpt_verified === "verified" ? "✓" : pd ? "✗" : "—";
    const sbcInCost = sbc?.inCostDescription ?? "—";
    const sbcVerified =
      sbc?.patternP8?.source_excerpt_verified === "verified" ? "✓" : sbc ? "✗" : "—";
    let flag = "";
    if (!pd && sbc) flag = "  <-- MISSING in plan_doc";
    else if (pd && !sbc) flag = "  <-- MISSING in SBC parser";
    else if (pdVerified !== sbcVerified) flag = "  <-- VERIFY diff";
    console.log(
      `${slug.padEnd(36)} ${String(pdInCost).slice(0, 22).padEnd(22)} ${pdVerified.padEnd(14)} ${String(sbcInCost).slice(0, 22).padEnd(22)} ${sbcVerified.padEnd(14)} ${flag}`,
    );
  }

  // Cite-grade summary counts
  const pdServicesVerified = planDocResult.services.filter(
    (s) => s.patternP8?.source_excerpt_verified === "verified",
  ).length;
  const sbcServicesVerified = sbcResult.services.filter(
    (s) => s.patternP8?.source_excerpt_verified === "verified",
  ).length;
  const pdPiVerified = Object.values(planDocPI).filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (f: any) => f?.patternP8?.source_excerpt_verified === "verified",
  ).length;
  const sbcPiVerified = Object.values(sbcPI).filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (f: any) => f?.patternP8?.source_excerpt_verified === "verified",
  ).length;
  console.log("\n========== CITE-GRADE SUMMARY ==========");
  console.log(
    `plan_doc: planIdentity verified ${pdPiVerified}/${Object.keys(planDocPI).length} | services verified ${pdServicesVerified}/${planDocResult.services.length}`,
  );
  console.log(
    `sbc:      planIdentity verified ${sbcPiVerified}/${Object.keys(sbcPI).length} | services verified ${sbcServicesVerified}/${sbcResult.services.length}`,
  );
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
