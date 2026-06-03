/**
 * Ing-D.0d dry-run (Ship Gate G3) — READ-ONLY Layer-3(b) minority-router calibration.
 *
 * No writes, no Haiku. Runs the REAL read-only gather (gatherLayer3Inputs) + the REAL
 * pure builder (buildMinorityReviewRows) over live PROD canonicals to answer, BEFORE
 * the flag is ever flipped:
 *
 *   "How many minority divergence-review rows would the router create on TODAY's data,
 *    and how much admin-queue load is that?"
 *
 * v3 surfaces 0 minorities (silent outlier-elimination). v4 would surface N. A result
 * of 0 on a sparse/stable post-wipe corpus is the VALID "no split to surface" baseline
 * — the fixture carries the FIRE proof; this proves v4 does not OVER-surface on real
 * data + quantifies the cold-start admin load (the fire-floor de-risk).
 *
 * Run: npx tsx scripts/cf40-v4-minority-dryrun.ts
 */

import { config } from "dotenv";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import {
  gatherLayer3Inputs,
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

async function main() {
  console.log("\n══ Ing-D.0d minority-router dry-run — READ-ONLY (no writes) ══\n");

  // 1. Enumerate canonicals with ≥2 user uploads (a split needs ≥2 distinct rows).
  //    Cheap proxy that bounds the per-canonical gather to plausible candidates.
  const { data: planRows, error } = await supabase
    .from("insurance_plans")
    .select("canonical_plan_id, user_id")
    .not("canonical_plan_id", "is", null)
    .limit(100_000);
  if (error) {
    console.error("query failed:", error.message);
    process.exit(1);
  }
  const usersByCanonical = new Map<string, Set<string>>();
  for (const r of planRows ?? []) {
    const c = r.canonical_plan_id as string;
    const s = usersByCanonical.get(c) ?? new Set<string>();
    s.add(r.user_id as string);
    usersByCanonical.set(c, s);
  }
  const candidates = [...usersByCanonical.entries()].filter(([, users]) => users.size >= 2);
  console.log(`canonicals with user uploads: ${usersByCanonical.size}`);
  console.log(`canonicals with ≥2 distinct uploaders (gather candidates): ${candidates.length}\n`);

  if (candidates.length === 0) {
    console.log("→ 0 candidates. v3 surfaces 0 minorities; v4 would surface 0.");
    console.log("  VALID 'no split to surface' baseline on the sparse post-wipe corpus.\n");
    return;
  }

  // 2. Per (canonical, doc_type): real read-only gather + pure builder. Count rows.
  let pairsEvaluated = 0;
  let pairsWithSplit = 0;
  let totalRows = 0;
  let plausibleRows = 0;
  const fired: string[] = [];

  for (const [canonicalId] of candidates) {
    for (const docType of DOC_TYPES) {
      const inputs = await gatherLayer3Inputs(supabase, canonicalId, docType, NOW);
      if (!inputs) continue; // no uploads of this doc_type
      pairsEvaluated += 1;
      const rows = buildMinorityReviewRows(canonicalId, docType, inputs);
      if (rows.length === 0) continue;
      pairsWithSplit += 1;
      totalRows += rows.length;
      for (const row of rows) {
        if (row.minorityValueJsonb.plausible === true) plausibleRows += 1;
        fired.push(
          `${canonicalId.slice(0, 8)}…|${docType} field=${row.fieldName} val=${row.minorityValueKey} w=${row.minorityWeight}/${row.totalWeight} plausible=${row.minorityValueJsonb.plausible} users=${row.contributingUserIds.length}`,
        );
      }
    }
  }

  console.log("── Result ──");
  console.log(`(canonical, doc_type) pairs evaluated (had user uploads): ${pairsEvaluated}`);
  console.log(`pairs with a minority split: ${pairsWithSplit}`);
  console.log(`v3 (today): 0 minorities surfaced (silent outlier-elimination).`);
  console.log(`v4 WOULD create divergence-review rows: ${totalRows} (${plausibleRows} plausible, ${totalRows - plausibleRows} implausible/stamped)`);
  if (fired.length) {
    console.log("\nrows (inspect for cold-start admin load + threshold calibration before Ing-D.1):");
    for (const f of fired.slice(0, 50)) console.log(`  • ${f}`);
    if (fired.length > 50) console.log(`  … and ${fired.length - 50} more`);
  } else {
    console.log("\n→ 0 rows. v4 does not over-surface on today's data (valid stable baseline).");
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
