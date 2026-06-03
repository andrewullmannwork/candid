/**
 * Ing-D.0c dry-run (Ship Gate G3) — READ-ONLY slow-drift analysis over PROD rows.
 *
 * No writes, no Haiku. Reconstructs the §2.7(a) slow-drift decision from live data
 * to answer, BEFORE the flag is ever flipped:
 *
 *   "How often would slow-drift fire on TODAY's data?"
 *
 * This is the before/after baseline for an invalidation gate: v3 has NO slow-drift
 * (fires 0); v4 would fire on N. A result of 0 fires on a sparse/stable post-wipe
 * corpus is the VALID "uniformly stable" outcome — the fixtures carry the FIRE
 * proof; this proves v4 does not OVER-fire on real data. Any unexpected fire is a
 * threshold-calibration signal to surface before Ing-D.1.
 *
 * Run: npx tsx scripts/cf40-v4-slow-drift-dryrun.ts
 */

import { config } from "dotenv";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import {
  computeSlowDrift,
  coerceScalar,
  SLOW_DRIFT_IDENTITY_FIELDS,
  type DriftExtractionRow,
} from "@/lib/parser/cf40-v4";

config({ path: resolve(process.cwd(), ".env.local") });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
  { auth: { persistSession: false } },
);

const NOW = new Date();
const WINDOW_START = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
const FIELD_NAMES = SLOW_DRIFT_IDENTITY_FIELDS.map((f) => f.extractionField);

async function main() {
  console.log("\n══ Ing-D.0c slow-drift dry-run — READ-ONLY (no writes) ══");
  console.log(`window: last 30d (since ${WINDOW_START})\n`);

  // 1. 30d plan-identity extractions (service_slug NULL).
  const { data: extractions, error } = await supabase
    .from("canonical_haiku_extractions")
    .select("canonical_plan_id, parser_kind, field_name, user_id, extracted_value, created_at")
    .is("service_slug", null)
    .in("field_name", FIELD_NAMES)
    .gte("created_at", WINDOW_START)
    .limit(50_000);
  if (error) {
    console.error("query failed:", error.message);
    process.exit(1);
  }
  console.log(`30d identity extractions: ${extractions?.length ?? 0}`);
  if (!extractions || extractions.length === 0) {
    console.log("\nNo 30d identity extractions in PROD → 0 (canonical, doc_type) evaluable.");
    console.log("v3 fires 0; v4 would fire 0. VALID 'no data / uniformly stable' baseline.\n");
    return;
  }

  // 2. Verified-user gate (Pattern 1 #15).
  const userIds = [...new Set(extractions.map((e) => e.user_id as string))];
  const { data: users } = await supabase
    .from("users")
    .select("id, email_verified, phone_verified")
    .in("id", userIds);
  const verified = new Set(
    (users ?? [])
      .filter((u) => u.email_verified === true && u.phone_verified === true)
      .map((u) => u.id as string),
  );
  console.log(`distinct uploaders: ${userIds.length} (verified email+phone: ${verified.size})`);

  // 3. Served baselines (canonical_plans, UN-prefixed cols).
  const canonicalIds = [...new Set(extractions.map((e) => e.canonical_plan_id as string))];
  const { data: canons } = await supabase
    .from("canonical_plans")
    .select("id, deductible_individual, deductible_family, oop_max_individual, oop_max_family")
    .in("id", canonicalIds);
  const baselineByCanonical = new Map<string, Record<string, number | null>>();
  for (const c of canons ?? []) {
    const b: Record<string, number | null> = {};
    for (const f of SLOW_DRIFT_IDENTITY_FIELDS) {
      b[f.extractionField] = (c[f.canonicalColumn as keyof typeof c] as number | null) ?? null;
    }
    baselineByCanonical.set(c.id as string, b);
  }
  console.log(`canonicals touched: ${canonicalIds.length}\n`);

  // 4. Group by (canonical, parser_kind), compute slow-drift PER PAIR (read-only).
  const groups = new Map<string, DriftExtractionRow[]>();
  for (const e of extractions) {
    if (!verified.has(e.user_id as string)) continue; // verified-only denominator
    const key = `${e.canonical_plan_id}|${e.parser_kind}`;
    const arr = groups.get(key) ?? [];
    arr.push({
      extractionField: e.field_name as string,
      userId: e.user_id as string,
      value: coerceScalar(e.extracted_value),
      createdAt: e.created_at as string,
    });
    groups.set(key, arr);
  }

  let evaluated = 0;
  let wouldFire = 0;
  const rateBuckets = { "0": 0, "0_0.3": 0, "0.3_1": 0 };
  const fired: string[] = [];

  for (const [key, rows] of groups) {
    const [canonicalId] = key.split("|");
    const baseline = baselineByCanonical.get(canonicalId);
    if (!baseline) continue;
    evaluated += 1;
    const r = computeSlowDrift({ rows, baseline });
    if (r.divergenceRate === 0) rateBuckets["0"] += 1;
    else if (r.divergenceRate <= 0.3) rateBuckets["0_0.3"] += 1;
    else rateBuckets["0.3_1"] += 1;
    if (r.triggered) {
      wouldFire += 1;
      fired.push(`${key}  field=${r.worstField} rate=${r.divergenceRate} users=${r.divergentUserCount}/${r.totalUserCount} base=${r.baselineValue} -> ${r.divergentValue}`);
    }
  }

  console.log("── Result ──");
  console.log(`(canonical, doc_type) pairs evaluated (verified data): ${evaluated}`);
  console.log(`divergence-rate distribution: rate=0 → ${rateBuckets["0"]}, 0<rate≤0.3 → ${rateBuckets["0_0.3"]}, rate>0.3 → ${rateBuckets["0.3_1"]}`);
  console.log(`\nv3 (today): 0 slow-drift fires (no Layer 4).`);
  console.log(`v4 WOULD fire (rate>0.3 AND count≥3): ${wouldFire}`);
  if (fired.length) {
    console.log("\nfires (inspect for false-alarm / threshold calibration before Ing-D.1):");
    for (const f of fired) console.log(`  • ${f}`);
  } else {
    console.log("\n→ 0 fires. v4 is non-over-firing on today's data (valid stable baseline).");
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
