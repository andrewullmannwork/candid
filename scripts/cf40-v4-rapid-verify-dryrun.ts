/**
 * Ing-D.0c-ii dry-run (Ship Gate G3) — READ-ONLY rapid-change + verification-mode
 * analysis over PROD rows. No writes, no Haiku.
 *
 * Answers, BEFORE the flag is ever flipped:
 *   "How often would rapid-change (§2.7b) fire / route-to-admin on TODAY's data?"
 *   "Is any canonical currently stuck in a verification-mode / Layer-4 state?"
 *
 * v3 has NO Layer 4 (fires 0). 0 rapid-change dispositions on a sparse/stable
 * post-wipe corpus is the VALID "uniformly stable" outcome — the fixtures carry
 * the FIRE proof; this proves v4 does not OVER-fire on real data. Diversity is not
 * collected, so auto_fire is unreachable via this path (matches the IO abstention);
 * any admin_review here is a plausible scale-sufficient convergence worth inspecting.
 *
 * Run: npx tsx scripts/cf40-v4-rapid-verify-dryrun.ts
 */

import { config } from "dotenv";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import {
  computeRapidChange,
  coerceScalar,
  getScaleTier,
  RAPID_CHANGE_THRESHOLDS,
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
const MAX_WINDOW_DAYS = 14; // widest rapid-change window (small+); cold_start re-filters to 7d
const WINDOW_START = new Date(NOW.getTime() - MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
const FIELD_NAMES = SLOW_DRIFT_IDENTITY_FIELDS.map((f) => f.extractionField);
const NO_DIVERSITY = { ipBlocks: null, asns: null, emailDomains: null };

async function main() {
  console.log("\n══ Ing-D.0c-ii rapid-change + verification dry-run — READ-ONLY (no writes) ══");
  console.log(`window: last ${MAX_WINDOW_DAYS}d (since ${WINDOW_START})\n`);

  // ── Verification-mode + Layer-4 state sanity (expect all 0 pre-flag) ──────────
  const { count: pendingVerif } = await supabase
    .from("canonical_plans")
    .select("id", { count: "exact", head: true })
    .eq("divergence_pending_verification", true);
  const { count: invalEvents } = await supabase
    .from("canonical_invalidation_events")
    .select("id", { count: "exact", head: true });
  const { count: driftEvents } = await supabase
    .from("canonical_drift_events")
    .select("id", { count: "exact", head: true });
  console.log("── Layer-4 state (cf40_v4_algorithm OFF → expect 0) ──");
  console.log(`canonicals divergence_pending_verification=TRUE: ${pendingVerif ?? 0}`);
  console.log(`canonical_invalidation_events rows: ${invalEvents ?? 0}`);
  console.log(`canonical_drift_events rows: ${driftEvents ?? 0}\n`);

  // ── Rapid-change dry-run ──────────────────────────────────────────────────────
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
  console.log(`${MAX_WINDOW_DAYS}d identity extractions: ${extractions?.length ?? 0}`);
  if (!extractions || extractions.length === 0) {
    console.log("\nNo in-window identity extractions in PROD → 0 (canonical, doc_type) evaluable.");
    console.log("v3 fires 0; v4 rapid-change would fire 0. VALID 'no data / uniformly stable' baseline.\n");
    return;
  }

  // Verified-user gate (Pattern 1 #15).
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

  // Served baseline + scale tier (extraction_count) per canonical.
  const canonicalIds = [...new Set(extractions.map((e) => e.canonical_plan_id as string))];
  const { data: canons } = await supabase
    .from("canonical_plans")
    .select("id, extraction_count, deductible_individual, deductible_family, oop_max_individual, oop_max_family")
    .in("id", canonicalIds);
  const baselineByCanonical = new Map<string, Record<string, number | null>>();
  const scaleByCanonical = new Map<string, ReturnType<typeof getScaleTier>>();
  for (const c of canons ?? []) {
    const b: Record<string, number | null> = {};
    for (const f of SLOW_DRIFT_IDENTITY_FIELDS) {
      b[f.extractionField] = (c[f.canonicalColumn as keyof typeof c] as number | null) ?? null;
    }
    baselineByCanonical.set(c.id as string, b);
    scaleByCanonical.set(c.id as string, getScaleTier((c.extraction_count as number | null) ?? 0));
  }
  console.log(`canonicals touched: ${canonicalIds.length}\n`);

  // Group by (canonical, parser_kind); re-filter to that canonical's scale window.
  const groups = new Map<string, DriftExtractionRow[]>();
  for (const e of extractions) {
    if (!verified.has(e.user_id as string)) continue;
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
  const tally = { none: 0, admin_review: 0, auto_fire: 0 };
  const flagged: string[] = [];

  for (const [key, allRows] of groups) {
    const [canonicalId] = key.split("|");
    const baseline = baselineByCanonical.get(canonicalId);
    const scaleTier = scaleByCanonical.get(canonicalId);
    if (!baseline || !scaleTier) continue;
    const thresholds = RAPID_CHANGE_THRESHOLDS[scaleTier];
    const windowStart = NOW.getTime() - thresholds.timeWindowDays * 24 * 60 * 60 * 1000;
    const rows = allRows.filter((r) => new Date(r.createdAt).getTime() >= windowStart);
    if (rows.length === 0) continue;
    evaluated += 1;
    const r = computeRapidChange({ rows, baseline, thresholds, diversity: NO_DIVERSITY });
    tally[r.disposition] += 1;
    if (r.disposition !== "none") {
      flagged.push(
        `${key} [${scaleTier}] field=${r.worstField} converging=${r.convergingUserCount}/${r.totalUserCount} base=${r.baselineValue} -> ${r.challengerValue} (${r.disposition})`,
      );
    }
  }

  console.log("── Rapid-change result ──");
  console.log(`(canonical, doc_type) pairs evaluated (verified data): ${evaluated}`);
  console.log(`dispositions: none=${tally.none}, admin_review=${tally.admin_review}, auto_fire=${tally.auto_fire}`);
  console.log(`\nv3 (today): 0 rapid-change actions (no Layer 4).`);
  console.log(`v4 WOULD route/fire: ${tally.admin_review + tally.auto_fire} (auto_fire=${tally.auto_fire} — 0 expected; diversity not collected → admin_review path).`);
  if (flagged.length) {
    console.log("\nflagged (inspect for false-alarm / threshold calibration before Ing-D.1):");
    for (const f of flagged) console.log(`  • ${f}`);
  } else {
    console.log("\n→ 0 dispositions. v4 rapid-change is non-over-firing on today's data (valid stable baseline).");
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
