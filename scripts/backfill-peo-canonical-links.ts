/**
 * One-time backfill: link historical PEO-administered insurance_plans rows
 * to the right carrier canonical via plan-name carrier inference.
 *
 * Some users (e.g., Sequoia One PEO → Cigna Open Access Plus) have an
 * insurance_plans row whose `insurer_name` is the PEO and whose
 * `canonical_plan_id` is therefore null — `matchInsurerCatalog` couldn't
 * resolve the PEO against the carrier catalog. The forward-looking fix
 * lives in process-plan.ts (see matchInsurerWithPlanFallback). This
 * script handles existing rows that were imported before that fix.
 *
 * For each `insurance_plans` row where `canonical_plan_id IS NULL`:
 *   1. Try plan-name carrier inference (inferCarrierFromPlanName)
 *   2. Resolve to a catalog insurer id (matchInsurerCatalog)
 *   3. Look up the canonical_plans row for (insurer_id, plan_name, plan_year)
 *   4. If found, set insurance_plans.canonical_plan_id
 *
 * Does NOT create new canonical_plans rows. The forward-looking path in
 * process-plan.ts handles canonical creation; this script only fills gaps
 * where a matching canonical already exists.
 *
 * Usage:
 *   npx tsx scripts/backfill-peo-canonical-links.ts --dry-run   # report only
 *   npx tsx scripts/backfill-peo-canonical-links.ts             # execute
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(__dirname, "../.env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

interface InsurancePlanRow {
  id: string;
  user_id: string;
  insurer_name: string | null;
  plan_name: string | null;
  plan_year: number | null;
  canonical_plan_id: string | null;
}

interface InsurerCatalogRow {
  id: string;
  name: string;
  aliases: string[] | null;
}

interface CanonicalPlanRow {
  id: string;
  insurer_id: string;
  plan_name: string;
  plan_year: number | null;
}

// Mirrored from src/lib/disputes/plan-context.ts so this script has no
// runtime dependency on the Next.js app build.
const CARRIER_PRODUCT_KEYWORDS: Array<{ match: RegExp; carrier: string }> = [
  { match: /open\s+access\s+plus/i, carrier: "Cigna" },
  { match: /choice\s+plus/i, carrier: "UnitedHealthcare" },
  { match: /optimum\s+choice/i, carrier: "UnitedHealthcare" },
  { match: /\bppo\s+select\b/i, carrier: "Aetna" },
  { match: /\baetna\s+open\s+choice\b/i, carrier: "Aetna" },
  { match: /\banthem\b/i, carrier: "Anthem Blue Cross Blue Shield" },
  { match: /blue\s+cross.*blue\s+shield/i, carrier: "Blue Cross Blue Shield Association" },
  { match: /\bbcbs\b/i, carrier: "Blue Cross Blue Shield Association" },
  { match: /\bkaiser\b/i, carrier: "Kaiser Permanente" },
  { match: /\bambetter\b/i, carrier: "Centene Ambetter" },
  { match: /\bmolina\b/i, carrier: "Molina Healthcare" },
  { match: /florida\s+blue/i, carrier: "Florida Blue" },
  { match: /\bhighmark\b/i, carrier: "Highmark BCBS" },
  { match: /\bpremera\b/i, carrier: "Premera Blue Cross" },
  { match: /\bregence\b/i, carrier: "Regence BlueShield" },
  { match: /independence\s+blue/i, carrier: "Independence Blue Cross" },
  { match: /carefirst/i, carrier: "CareFirst BlueCross BlueShield" },
  { match: /horizon\s+(?:bcbs|blue)/i, carrier: "Horizon Blue Cross Blue Shield of New Jersey" },
];

function inferCarrierFromPlanName(planName: string): string | null {
  for (const { match, carrier } of CARRIER_PRODUCT_KEYWORDS) {
    if (match.test(planName)) return carrier;
  }
  return null;
}

function matchInsurerInCatalog(
  catalog: InsurerCatalogRow[],
  rawName: string,
): InsurerCatalogRow | null {
  if (!rawName.trim()) return null;
  const normalized = rawName.trim().toLowerCase();
  for (const entry of catalog) {
    const name = (entry.name || "").toLowerCase();
    if (name === normalized) return entry;
    const aliases = entry.aliases || [];
    if (aliases.some((a) => a.toLowerCase() === normalized)) return entry;
    if (name.includes(normalized) || normalized.includes(name)) return entry;
    if (aliases.some((a) => {
      const al = a.toLowerCase();
      return al.includes(normalized) || normalized.includes(al);
    })) return entry;
  }
  return null;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment");
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  console.log(`\nPEO canonical-link backfill`);
  console.log(`  Mode: ${dryRun ? "DRY RUN" : "LIVE"}\n`);

  const [{ data: plans, error: plansErr }, { data: catalog, error: catalogErr }] = await Promise.all([
    supabase
      .from("insurance_plans")
      .select("id, user_id, insurer_name, plan_name, plan_year, canonical_plan_id")
      .is("canonical_plan_id", null),
    supabase
      .from("insurer_catalog")
      .select("id, name, aliases"),
  ]);

  if (plansErr || catalogErr) {
    console.error("Fetch failed:", plansErr ?? catalogErr);
    process.exit(1);
  }

  const planRows = (plans ?? []) as InsurancePlanRow[];
  const catalogRows = (catalog ?? []) as InsurerCatalogRow[];

  console.log(`  Plans with null canonical_plan_id: ${planRows.length}`);
  console.log(`  Insurer catalog size: ${catalogRows.length}\n`);

  let inferredHits = 0;
  let canonicalLinked = 0;
  let skippedNoInference = 0;
  let skippedNoCanonical = 0;
  let skippedDirectMatchPossible = 0;

  for (const plan of planRows) {
    if (!plan.plan_name) {
      skippedNoInference += 1;
      continue;
    }

    // Skip rows whose insurer_name DOES match the catalog directly — those
    // were left null for some other reason (e.g., catalog entry missing at
    // import time, or canonical plan not yet created). Re-running the
    // forward path on next upload will handle them.
    if (plan.insurer_name) {
      const direct = matchInsurerInCatalog(catalogRows, plan.insurer_name);
      if (direct) {
        skippedDirectMatchPossible += 1;
        continue;
      }
    }

    const inferred = inferCarrierFromPlanName(plan.plan_name);
    if (!inferred) {
      skippedNoInference += 1;
      continue;
    }

    const carrierEntry = matchInsurerInCatalog(catalogRows, inferred);
    if (!carrierEntry) {
      skippedNoInference += 1;
      continue;
    }

    inferredHits += 1;

    // Look up an existing canonical_plans row for (insurer_id, plan_name,
    // plan_year). Don't create one; the forward path owns canonical
    // creation. If multiple canonicals match (different states / groups),
    // pick the most-recently-created — best heuristic without per-user
    // location data here.
    const planYear = plan.plan_year ?? new Date().getFullYear();
    const { data: canonicals, error: canonicalErr } = await supabase
      .from("canonical_plans")
      .select("id, insurer_id, plan_name, plan_year")
      .eq("insurer_id", carrierEntry.id)
      .eq("plan_name", plan.plan_name)
      .eq("plan_year", planYear)
      .order("created_at", { ascending: false })
      .limit(1);

    if (canonicalErr) {
      console.error(`  Canonical lookup failed for plan ${plan.id}:`, canonicalErr);
      continue;
    }

    const canonical = (canonicals ?? [])[0] as CanonicalPlanRow | undefined;
    if (!canonical) {
      skippedNoCanonical += 1;
      console.log(`  ⊘ No canonical for "${plan.plan_name}" (${planYear}) under ${carrierEntry.name} — plan ${plan.id}`);
      continue;
    }

    console.log(
      `  ${dryRun ? "[dry] would link" : "→ linking"} plan ${plan.id} ("${plan.plan_name}", ${planYear}) → canonical ${canonical.id} (${carrierEntry.name})`,
    );

    if (!dryRun) {
      const { error: updateErr } = await supabase
        .from("insurance_plans")
        .update({ canonical_plan_id: canonical.id })
        .eq("id", plan.id);
      if (updateErr) {
        console.error(`  ✗ Update failed for plan ${plan.id}:`, updateErr);
        continue;
      }
      canonicalLinked += 1;
    }
  }

  console.log(`\nSummary:`);
  console.log(`  Plans scanned: ${planRows.length}`);
  console.log(`  Inferred via plan name: ${inferredHits}`);
  console.log(`  ${dryRun ? "Would link" : "Linked"}: ${dryRun ? inferredHits - skippedNoCanonical : canonicalLinked}`);
  console.log(`  Skipped (no plan-name inference): ${skippedNoInference}`);
  console.log(`  Skipped (insurer_name already matchable): ${skippedDirectMatchPossible}`);
  console.log(`  Skipped (no matching canonical_plans row): ${skippedNoCanonical}`);
  console.log(`\n${dryRun ? "Dry run complete. Re-run without --dry-run to execute." : "Backfill complete."}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
