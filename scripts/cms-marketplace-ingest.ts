#!/usr/bin/env npx tsx
/**
 * CMS Marketplace API Ingest Script
 *
 * Fetches all individual market plans from the CMS Marketplace API (HealthCare.gov)
 * and inserts them into Candid's plan_catalog + insurer_catalog tables.
 *
 * Usage:
 *   npx tsx scripts/cms-marketplace-ingest.ts                # all FFM states
 *   npx tsx scripts/cms-marketplace-ingest.ts --states TX,FL  # specific states
 *   npx tsx scripts/cms-marketplace-ingest.ts --test          # test mode (1 county per state)
 *
 * Requires: .env.local with NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "path";

// Load .env.local from the candid project root
config({ path: resolve(__dirname, "../.env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE env vars. Ensure .env.local is configured.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// CMS API config
const CMS_API_BASE = "https://marketplace.api.healthcare.gov/api/v1";
const CMS_API_KEY = process.env.CMS_API_KEY || "d687412e7b53146b2631dc01974ad0a4";
const PLAN_YEAR = 2025; // Current plan year

// FFM states (use the federal marketplace, not state-based exchanges)
const FFM_STATES = [
  "AL", "AK", "AR", "AZ", "DE", "FL", "GA", "HI", "IL", "IN",
  "IA", "KS", "LA", "ME", "MI", "MS", "MO", "MT", "NE", "NH",
  "NC", "ND", "OH", "OK", "OR", "SC", "SD", "TN", "TX", "UT",
  "WI", "WV", "WY",
  // These states use healthcare.gov for plan search but have their own exchanges:
  "AR", "KY", "NM", "NV",
];

// Deduplicate
const UNIQUE_FFM_STATES = [...new Set(FFM_STATES)];

// ── Types ────────────────────────────────────────────────────────────────────

interface CMSPlan {
  id: string;
  name: string;
  premium: number;
  metal_level: string;
  type: string; // HMO, PPO, EPO, POS
  state: string;
  deductibles: Array<{
    type: string;
    amount: number;
    network_tier: string;
    family_cost: string;
    individual: boolean;
  }>;
  moops: Array<{
    type: string;
    amount: number;
    network_tier: string;
    family_cost: string;
    individual: boolean;
  }>;
  benefits: Array<{
    type: string;
    name: string;
    covered: boolean;
    cost_sharings: Array<{
      coinsurance_rate: number;
      copay_amount: number;
      network_tier: string;
      display_string: string;
    }>;
  }>;
  benefits_url: string;
  issuer: {
    id: string;
    name: string;
  };
  hsa_eligible: boolean;
  quality_rating?: {
    global_rating: number;
  };
}

interface County {
  fips: string;
  name: string;
  state: string;
  zipcode: string;
}

// ── CMS API Helpers ──────────────────────────────────────────────────────────

async function fetchJSON(url: string, body?: object): Promise<any> {
  const options: RequestInit = {
    headers: { "Content-Type": "application/json" },
  };
  if (body) {
    options.method = "POST";
    options.body = JSON.stringify(body);
  }
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CMS API error ${res.status}: ${text}`);
  }
  return res.json();
}

/** Get all counties for a state using sample zipcodes */
async function getCountiesForState(state: string): Promise<County[]> {
  // Use the CMS counties endpoint with a broad zipcode search
  // The API also supports getting counties by state directly
  try {
    const url = `${CMS_API_BASE}/counties?apikey=${CMS_API_KEY}&state=${state}&year=${PLAN_YEAR}`;
    const data = await fetchJSON(url);
    if (data.counties) {
      return data.counties.map((c: any) => ({
        fips: c.fips,
        name: c.name,
        state: c.state,
        zipcode: c.zipcode || "",
      }));
    }
  } catch {
    // Fallback: try the /counties endpoint with different format
  }

  // Alternative: get counties via a known zipcode per state
  const stateZips: Record<string, string> = {
    AL: "35203", AK: "99501", AR: "72201", AZ: "85001", DE: "19901",
    FL: "33101", GA: "30301", HI: "96801", IL: "60601", IN: "46201",
    IA: "50301", KS: "66601", KY: "40201", LA: "70112", ME: "04101",
    MI: "48201", MN: "55401", MS: "39201", MO: "63101", MT: "59601",
    NE: "68501", NH: "03301", NC: "27601", ND: "58501", NM: "87101",
    NV: "89101", OH: "43201", OK: "73101", OR: "97201", SC: "29201",
    SD: "57501", TN: "37201", TX: "77001", UT: "84101", WI: "53201",
    WV: "25301", WY: "82001",
  };

  const zip = stateZips[state];
  if (!zip) return [];

  try {
    const url = `${CMS_API_BASE}/counties/by/zip/${zip}?apikey=${CMS_API_KEY}`;
    const data = await fetchJSON(url);
    return (data.counties || []).map((c: any) => ({
      fips: c.fips,
      name: c.name,
      state: c.state,
      zipcode: zip,
    }));
  } catch (err) {
    console.warn(`  Failed to get counties for ${state}: ${err}`);
    return [];
  }
}

/** Fetch all plans for a given county */
async function fetchPlansForCounty(
  state: string,
  fips: string,
  zipcode: string
): Promise<{ plans: CMSPlan[]; total: number }> {
  const PAGE_SIZE = 50;
  let offset = 0;
  let allPlans: CMSPlan[] = [];
  let total = 0;

  while (true) {
    const url = `${CMS_API_BASE}/plans/search?apikey=${CMS_API_KEY}`;
    const body = {
      place: { state, countyfips: fips, zipcode },
      market: "Individual",
      year: PLAN_YEAR,
      limit: PAGE_SIZE,
      offset,
    };

    const data = await fetchJSON(url, body);
    total = data.total || 0;

    if (!data.plans || data.plans.length === 0) break;

    allPlans = allPlans.concat(data.plans);
    offset += PAGE_SIZE;

    if (offset >= total) break;

    // Rate limiting — be respectful
    await sleep(200);
  }

  return { plans: allPlans, total };
}

// ── Database Operations ──────────────────────────────────────────────────────

/** Get or create insurer in catalog */
async function ensureInsurer(
  issuerId: string,
  issuerName: string
): Promise<string> {
  // Check by cms_issuer_id first
  const { data: existing } = await supabase
    .from("insurer_catalog")
    .select("id")
    .eq("cms_issuer_id", issuerId)
    .single();

  if (existing) return existing.id;

  // Check by name (fuzzy)
  const { data: byName } = await supabase
    .from("insurer_catalog")
    .select("id")
    .ilike("name", `%${issuerName.split(" ")[0]}%`)
    .limit(1)
    .single();

  if (byName) {
    // Update existing with CMS issuer ID
    await supabase
      .from("insurer_catalog")
      .update({ cms_issuer_id: issuerId })
      .eq("id", byName.id);
    return byName.id;
  }

  // Create new
  const { data: created, error } = await supabase
    .from("insurer_catalog")
    .insert({
      name: issuerName,
      cms_issuer_id: issuerId,
      data_status: "extracted",
    })
    .select("id")
    .single();

  if (error) {
    console.warn(`  Failed to create insurer ${issuerName}: ${error.message}`);
    // Return a placeholder — don't block ingestion
    const { data: retry } = await supabase
      .from("insurer_catalog")
      .select("id")
      .ilike("name", `%${issuerName.split(" ")[0]}%`)
      .limit(1)
      .single();
    return retry?.id || "";
  }

  return created.id;
}

/** Upsert a plan into plan_catalog */
async function upsertPlan(plan: CMSPlan, insurerId: string, county: string, fips: string) {
  // Extract deductible and OOP max for individual in-network
  const deductible = plan.deductibles?.find(
    (d) => d.individual && d.network_tier === "In-Network"
  )?.amount;
  const oopMax = plan.moops?.find(
    (m) => m.individual && m.network_tier === "In-Network"
  )?.amount;

  const record = {
    hios_id: plan.id,
    insurer_id: insurerId,
    plan_name: plan.name,
    plan_type: plan.type,
    state: plan.state,
    year: PLAN_YEAR,
    source_type: "cms_api",
    data_status: "extracted",
    metal_level: plan.metal_level,
    marketplace_type: "ffm",
    premium_individual: plan.premium,
    sbc_document_url: plan.benefits_url || null,
    county,
    fips_code: fips,
    raw_data: {
      deductible_individual: deductible,
      oop_max_individual: oopMax,
      hsa_eligible: plan.hsa_eligible,
      quality_rating: plan.quality_rating?.global_rating,
      benefits_summary: plan.benefits?.map((b) => ({
        type: b.type,
        name: b.name,
        covered: b.covered,
        in_network: b.cost_sharings?.find((cs) => cs.network_tier === "In-Network")?.display_string,
      })),
    },
  };

  // Check if plan already exists
  const { data: existing } = await supabase
    .from("plan_catalog")
    .select("id")
    .eq("hios_id", plan.id)
    .single();

  if (existing) {
    // Update existing
    const { error } = await supabase
      .from("plan_catalog")
      .update(record)
      .eq("id", existing.id);
    if (error) console.warn(`  Failed to update plan ${plan.id}: ${error.message}`);
  } else {
    // Insert new
    const { error } = await supabase
      .from("plan_catalog")
      .insert(record);
    if (error) {
      if (!error.message.includes("duplicate")) {
        console.warn(`  Failed to insert plan ${plan.id}: ${error.message}`);
      }
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = process.argv.slice(2);
  const testMode = args.includes("--test");
  const stateArg = args.find((a) => a.startsWith("--states="));
  const targetStates = stateArg
    ? stateArg.split("=")[1].split(",")
    : UNIQUE_FFM_STATES;

  console.log(`\n🏥 CMS Marketplace Ingest`);
  console.log(`   Year: ${PLAN_YEAR}`);
  console.log(`   States: ${targetStates.join(", ")}${testMode ? " (TEST MODE)" : ""}`);
  console.log(`   Supabase: ${SUPABASE_URL}\n`);

  let totalPlans = 0;
  let totalInsurers = 0;
  const insurerCache = new Map<string, string>(); // cms_issuer_id → catalog_id
  const seenPlanIds = new Set<string>();

  for (const state of targetStates) {
    console.log(`\n── ${state} ──────────────────────────────`);

    // Get counties for this state
    const counties = await getCountiesForState(state);
    if (counties.length === 0) {
      console.log(`  No counties found, skipping`);
      continue;
    }

    console.log(`  ${counties.length} county(ies) found`);

    // In test mode, only process first county
    const countiesToProcess = testMode ? [counties[0]] : counties;
    let statePlans = 0;

    for (const county of countiesToProcess) {
      try {
        const { plans, total } = await fetchPlansForCounty(
          state,
          county.fips,
          county.zipcode
        );

        if (plans.length === 0) continue;

        // Deduplicate across counties (same plan can appear in multiple counties)
        const newPlans = plans.filter((p) => !seenPlanIds.has(p.id));
        for (const p of plans) seenPlanIds.add(p.id);

        if (newPlans.length === 0) {
          continue; // All plans already seen from another county
        }

        // Ensure insurers exist
        for (const plan of newPlans) {
          const issuerId = plan.issuer.id;
          if (!insurerCache.has(issuerId)) {
            const catalogId = await ensureInsurer(issuerId, plan.issuer.name);
            insurerCache.set(issuerId, catalogId);
            if (!insurerCache.has(issuerId)) totalInsurers++;
          }
        }

        // Upsert plans
        for (const plan of newPlans) {
          const insurerCatalogId = insurerCache.get(plan.issuer.id) || "";
          await upsertPlan(plan, insurerCatalogId, county.name, county.fips);
          statePlans++;
        }

        process.stdout.write(
          `  ${county.name} (${county.fips}): ${total} total, ${newPlans.length} new\r`
        );

        // Rate limiting
        await sleep(300);
      } catch (err) {
        console.warn(`  Error in ${county.name}: ${err}`);
      }
    }

    totalPlans += statePlans;
    console.log(`  ${state} complete: ${statePlans} plans ingested`);
  }

  console.log(`\n✅ Ingest complete`);
  console.log(`   Total plans: ${totalPlans}`);
  console.log(`   Unique plan IDs: ${seenPlanIds.size}`);
  console.log(`   Insurers: ${insurerCache.size}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
