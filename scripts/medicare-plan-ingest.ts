#!/usr/bin/env npx tsx
/**
 * Medicare Plan Ingest Script
 *
 * Fetches Medicare Advantage (Part C) and Part D plans from the CMS
 * Medicare Plan Finder API and inserts them into Candid's plan_catalog.
 *
 * Data sources:
 *   - CMS Medicare Plan Finder API (public, no auth)
 *   - Medicare Plan Compare data files
 *
 * Usage:
 *   npx tsx scripts/medicare-plan-ingest.ts                 # all states
 *   npx tsx scripts/medicare-plan-ingest.ts --states TX,FL  # specific states
 *   npx tsx scripts/medicare-plan-ingest.ts --test          # test mode (1 state)
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(__dirname, "../.env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE env vars. Ensure .env.local is configured.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// CMS Medicare Plan Finder API
// Documentation: https://data.cms.gov/provider-data/topics/medicare-plan-finder
const MEDICARE_API_BASE = "https://data.cms.gov/provider-data/api/1/datastore/query";

// Medicare Advantage plan dataset ID (check CMS for current ID)
const MA_DATASET_ID = "aaxe-avy2"; // Medicare Advantage plan data

// All US states + DC
const ALL_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN",
  "IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH",
  "NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT",
  "VT","VA","WA","WV","WI","WY",
];

// ── Types ──────────────────────────────────────────────────────────────────────

interface MedicarePlan {
  contract_id: string;
  plan_id: string;
  segment_id?: string;
  organization_name: string;
  plan_name: string;
  plan_type: string;        // HMO, PPO, PFFS, SNP, etc.
  state: string;
  county: string;
  premium: string;           // monthly premium
  deductible: string;        // annual deductible
  drug_deductible?: string;
  max_out_of_pocket?: string;
  star_rating?: string;
  snp_type?: string;         // Special Needs Plan type
  part_d_coverage?: string;
}

// ── Database Operations ────────────────────────────────────────────────────────

const insurerCache = new Map<string, string>();

async function ensureInsurer(name: string): Promise<string> {
  const cacheKey = name.toLowerCase();
  if (insurerCache.has(cacheKey)) return insurerCache.get(cacheKey)!;

  const { data: existing } = await supabase
    .from("insurer_catalog")
    .select("id")
    .ilike("name", `%${name.split(" ")[0]}%`)
    .limit(1)
    .single();

  if (existing) {
    insurerCache.set(cacheKey, existing.id);
    return existing.id;
  }

  const { data: created, error } = await supabase
    .from("insurer_catalog")
    .insert({ name, data_status: "extracted" })
    .select("id")
    .single();

  if (error) {
    console.warn(`  Failed to create insurer ${name}: ${error.message}`);
    return "";
  }

  insurerCache.set(cacheKey, created.id);
  return created.id;
}

async function upsertMedicarePlan(plan: MedicarePlan, insurerId: string) {
  const hiosId = `MA-${plan.contract_id}-${plan.plan_id}`;
  const premium = parseFloat(plan.premium?.replace(/[,$]/g, "")) || null;
  const deductible = parseFloat(plan.deductible?.replace(/[,$]/g, "")) || null;
  const oopMax = plan.max_out_of_pocket ? parseFloat(plan.max_out_of_pocket.replace(/[,$]/g, "")) || null : null;

  // Map Medicare plan types to standard types
  const typeMap: Record<string, string> = {
    "HMO": "HMO",
    "Local HMO": "HMO",
    "Local PPO": "PPO",
    "Regional PPO": "PPO",
    "PPO": "PPO",
    "PFFS": "PFFS",
    "HMO-POS": "HMO",
    "MSA": "HDHP",
  };

  const record = {
    hios_id: hiosId,
    insurer_id: insurerId,
    plan_name: plan.plan_name,
    plan_type: typeMap[plan.plan_type] || plan.plan_type,
    state: plan.state,
    year: new Date().getFullYear(),
    source_type: "cms_api",
    data_status: "extracted",
    metal_level: null,
    marketplace_type: "medicare",
    premium_individual: premium,
    county: plan.county,
    raw_data: {
      deductible_individual: deductible,
      oop_max_individual: oopMax,
      contract_id: plan.contract_id,
      plan_id: plan.plan_id,
      star_rating: plan.star_rating ? parseFloat(plan.star_rating) : null,
      snp_type: plan.snp_type,
      part_d_coverage: plan.part_d_coverage,
      drug_deductible: plan.drug_deductible ? parseFloat(plan.drug_deductible.replace(/[,$]/g, "")) : null,
      medicare_plan_type: plan.plan_type,
    },
  };

  const { data: existing } = await supabase
    .from("plan_catalog")
    .select("id")
    .eq("hios_id", hiosId)
    .single();

  if (existing) {
    await supabase.from("plan_catalog").update(record).eq("id", existing.id);
  } else {
    const { error } = await supabase.from("plan_catalog").insert(record);
    if (error && !error.message.includes("duplicate")) {
      console.warn(`  Insert failed for ${hiosId}: ${error.message}`);
    }
  }
}

// ── CMS Medicare API ───────────────────────────────────────────────────────────

async function fetchMedicarePlans(state: string, limit: number): Promise<MedicarePlan[]> {
  const url = `${MEDICARE_API_BASE}/${MA_DATASET_ID}/0?limit=${limit}&offset=0&conditions[0][property]=state&conditions[0][operator]==&conditions[0][value]=${state}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`  Medicare API returned ${res.status} for ${state}`);
      return [];
    }
    const data = await res.json();
    return data.results || [];
  } catch (err) {
    console.warn(`  Medicare API fetch failed for ${state}: ${err}`);
    return [];
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = process.argv.slice(2);
  const testMode = args.includes("--test");
  const stateArg = args.find((a) => a.startsWith("--states="));
  const targetStates = stateArg
    ? stateArg.split("=")[1].split(",")
    : ALL_STATES;

  const statesToProcess = testMode ? [targetStates[0]] : targetStates;

  console.log(`\n🏥 Medicare Plan Ingest`);
  console.log(`   States: ${statesToProcess.join(", ")}${testMode ? " (TEST MODE)" : ""}`);
  console.log(`   Supabase: ${SUPABASE_URL}\n`);

  let totalIngested = 0;
  const seenIds = new Set<string>();

  for (const state of statesToProcess) {
    const plans = await fetchMedicarePlans(state, testMode ? 50 : 5000);

    if (plans.length === 0) {
      console.log(`  ${state}: no plans found`);
      continue;
    }

    // Deduplicate
    const uniquePlans = plans.filter((p) => {
      const key = `${p.contract_id}-${p.plan_id}`;
      if (seenIds.has(key)) return false;
      seenIds.add(key);
      return true;
    });

    let stateIngested = 0;
    for (const plan of uniquePlans) {
      const insurerId = await ensureInsurer(plan.organization_name);
      await upsertMedicarePlan(plan, insurerId);
      stateIngested++;
    }

    totalIngested += stateIngested;
    console.log(`  ${state}: ${stateIngested} plans ingested (${uniquePlans.length} unique of ${plans.length})`);

    await sleep(500); // Rate limit between states
  }

  console.log(`\n✅ Medicare Ingest complete`);
  console.log(`   Total plans: ${totalIngested}`);
  console.log(`   Unique plan IDs: ${seenIds.size}`);
  console.log(`   Insurers: ${insurerCache.size}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
