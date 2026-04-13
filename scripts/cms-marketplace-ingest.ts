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
const PLAN_YEAR = new Date().getFullYear(); // Derives from current year

// FFM states — verified to return data from the CMS Marketplace API (2026).
// States with their own exchanges (GA, IL, ME, KY, NM, NV) are NOT served by this API.
const FFM_STATES = [
  "AL", "AK", "AR", "AZ", "DE", "FL", "HI", "IN",
  "IA", "KS", "LA", "MI", "MS", "MO", "MT", "NE", "NH",
  "NC", "ND", "OH", "OK", "OR", "SC", "SD", "TN", "TX", "UT",
  "WI", "WV", "WY",
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

// State abbreviation → Census FIPS state code
const STATE_FIPS: Record<string, string> = {
  AL: "01", AK: "02", AZ: "04", AR: "05", CA: "06", CO: "08", CT: "09",
  DE: "10", FL: "12", GA: "13", HI: "15", ID: "16", IL: "17", IN: "18",
  IA: "19", KS: "20", KY: "21", LA: "22", ME: "23", MD: "24", MA: "25",
  MI: "26", MN: "27", MS: "28", MO: "29", MT: "30", NE: "31", NV: "32",
  NH: "33", NJ: "34", NM: "35", NY: "36", NC: "37", ND: "38", OH: "39",
  OK: "40", OR: "41", PA: "42", RI: "44", SC: "45", SD: "46", TN: "47",
  TX: "48", UT: "49", VT: "50", VA: "51", WA: "53", WV: "54", WI: "55",
  WY: "56",
};

// Reverse lookup: FIPS state code → state abbreviation
const FIPS_TO_STATE: Record<string, string> = Object.fromEntries(
  Object.entries(STATE_FIPS).map(([k, v]) => [v, k])
);

/**
 * Load Census ZCTA-to-County crosswalk file.
 * Returns a map: county FIPS → zip code (one zip per county).
 * Source: https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/
 */
import { readFileSync } from "fs";

let _crosswalkCache: Map<string, { zip: string; name: string; state: string }> | null = null;

function loadCrosswalk(): Map<string, { zip: string; name: string; state: string }> {
  if (_crosswalkCache) return _crosswalkCache;

  const filePath = resolve(__dirname, "data/zcta_county_crosswalk.txt");
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n");

  // county FIPS → { zip, name, state }
  const fipsMap = new Map<string, { zip: string; name: string; state: string }>();

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split("|");
    const zcta = cols[1]?.trim(); // GEOID_ZCTA5_20 (zip code)
    const countyFips = cols[9]?.trim(); // GEOID_COUNTY_20 (5-digit FIPS)
    const countyName = cols[10]?.trim(); // NAMELSAD_COUNTY_20

    if (!zcta || !countyFips || zcta.length !== 5 || countyFips.length !== 5) continue;

    // Only store the first (largest area) zip per county
    if (!fipsMap.has(countyFips)) {
      const stateFips = countyFips.slice(0, 2);
      const stateAbbr = FIPS_TO_STATE[stateFips] || "";
      fipsMap.set(countyFips, {
        zip: zcta,
        name: countyName || "",
        state: stateAbbr,
      });
    }
  }

  _crosswalkCache = fipsMap;
  return fipsMap;
}

/** Get all counties for a state from the Census crosswalk file */
function getCountiesForState(state: string): County[] {
  const crosswalk = loadCrosswalk();
  const stateFips = STATE_FIPS[state];
  if (!stateFips) return [];

  const counties: County[] = [];
  for (const [fips, data] of crosswalk) {
    if (fips.startsWith(stateFips)) {
      counties.push({
        fips,
        name: data.name,
        state,
        zipcode: data.zip,
      });
    }
  }

  return counties;
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
      benefits_summary: plan.benefits?.map((b) => {
        const inNetwork = b.cost_sharings?.find((cs) => cs.network_tier === "In-Network");
        return {
          type: b.type,
          name: b.name,
          covered: b.covered,
          in_network: inNetwork?.display_string || null,
          copay_amount: inNetwork?.copay_amount ?? null,
          coinsurance_rate: inNetwork?.coinsurance_rate ?? null,
        };
      }),
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

    // Crosswalk already provides zip per county — no probing needed

    // In test mode, only process first county
    const countiesToProcess = testMode ? [counties[0]] : counties;
    let statePlans = 0;
    let countiesWithNewPlans = 0;
    let countiesSkipped = 0;

    for (let i = 0; i < countiesToProcess.length; i++) {
      const county = countiesToProcess[i];
      try {
        // Zip comes from Census crosswalk — already validated per county
        const zip = county.zipcode;
        if (!zip) {
          countiesSkipped++;
          continue;
        }

        const { plans, total } = await fetchPlansForCounty(
          state,
          county.fips,
          zip
        );

        if (plans.length === 0) {
          countiesSkipped++;
          continue;
        }

        // Deduplicate across counties (same plan can appear in multiple counties)
        const newPlans = plans.filter((p) => !seenPlanIds.has(p.id));
        for (const p of plans) seenPlanIds.add(p.id);

        if (newPlans.length === 0) {
          countiesSkipped++;
          continue; // All plans already seen from another county
        }

        countiesWithNewPlans++;

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
          `  [${i + 1}/${countiesToProcess.length}] ${county.name} (${county.fips}): ${total} total, ${newPlans.length} new\n`
        );

        // Rate limiting
        await sleep(300);
      } catch (err) {
        countiesSkipped++;
        // Only log non-repetitive errors
        const errMsg = String(err);
        if (!errMsg.includes("not a valid marketplace state")) {
          console.warn(`  Error in ${county.name} (${county.fips}): ${err}`);
        }
      }
    }

    totalPlans += statePlans;
    console.log(`  ${state} complete: ${statePlans} new plans from ${countiesWithNewPlans} counties (${countiesSkipped} skipped/deduped)`);
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
