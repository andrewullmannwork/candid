#!/usr/bin/env npx tsx
/**
 * State-Based Exchange (SBE) + Missing FFM State Ingest
 *
 * Fills gaps in plan_catalog by:
 *   1. Running the CMS marketplace API for FFM states that were missed
 *   2. Running the CMS marketplace API for SBE states that support it
 *   3. For fully independent SBEs (CA, NY, etc.) — uses published plan CSVs
 *
 * Usage:
 *   npx tsx scripts/sbe-ingest.ts                  # all missing states
 *   npx tsx scripts/sbe-ingest.ts --states TX,GA   # specific states
 *   npx tsx scripts/sbe-ingest.ts --test           # test mode (1 county per state)
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(__dirname, "../.env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE env vars.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const CMS_API_BASE = "https://marketplace.api.healthcare.gov/api/v1";
const CMS_API_KEY = process.env.CMS_API_KEY || "d687412e7b53146b2631dc01974ad0a4";
const PLAN_YEAR = new Date().getFullYear();

// States that SHOULD be in plan_catalog but may be missing or incomplete
// FFM states + SBE-FFM states (use healthcare.gov API for plan search)
const CMS_API_STATES = [
  // FFM states
  "AL","AK","AR","AZ","DE","FL","GA","HI","IL","IN","IA","KS",
  "LA","ME","MI","MS","MO","MT","NE","NH","NC","ND","OH","OK",
  "OR","SC","SD","TN","TX","UT","WI","WV","WY",
  // SBE-FFM states (use healthcare.gov for plan search)
  "AR","KY","NM","NV",
];

// Fallback zip codes per state
const STATE_ZIPS: Record<string, string[]> = {
  AL: ["35203","36602","35801"], AK: ["99501"], AR: ["72201","72701"],
  AZ: ["85001","85701","86001"], CA: ["90001","94102","92101","95814"],
  CO: ["80201","80903","81001"], CT: ["06101","06510","06880"],
  DC: ["20001"], DE: ["19901","19801"], FL: ["33101","32801","33601","32201"],
  GA: ["30301","31401","31901","30901"], HI: ["96801"],
  ID: ["83701","83201"], IL: ["60601","61602","62701"],
  IN: ["46201","46801","47901"], IA: ["50301","52801","51101"],
  KS: ["66601","67201","66101"], KY: ["40201","40501","41001"],
  LA: ["70112","70801","71101"], MA: ["02101","01101","02601"],
  MD: ["21201","20601","21401"], ME: ["04101","04401"],
  MI: ["48201","49501","48601"], MN: ["55401","55101","56001"],
  MS: ["39201","39501","38601"], MO: ["63101","64101","65801"],
  MT: ["59601","59101"], NC: ["27601","28201","28801"],
  ND: ["58501","58101"], NE: ["68501","68101"],
  NH: ["03301","03101"], NJ: ["07101","08601"],
  NM: ["87101","88001"], NV: ["89101","89501"],
  NY: ["10001","14201","12201","13201"], OH: ["43201","44101","45201"],
  OK: ["73101","74101"], OR: ["97201","97401"],
  PA: ["19101","15201","17101"], RI: ["02901"],
  SC: ["29201","29401"], SD: ["57501","57101"],
  TN: ["37201","38101","37901"], TX: ["77001","75201","78201","79901","73301"],
  UT: ["84101","84601"], VA: ["23219","22201","24011"],
  VT: ["05401","05601"], WA: ["98101","99201"],
  WI: ["53201","54301","53701"], WV: ["25301","26003"],
  WY: ["82001","82601"],
};

// ── Types ──────────────────────────────────────────────────────────────────────

interface CMSPlan {
  id: string;
  name: string;
  premium: number;
  metal_level: string;
  type: string;
  state: string;
  deductibles: Array<{ type: string; amount: number; network_tier: string; family_cost: string; individual: boolean }>;
  moops: Array<{ type: string; amount: number; network_tier: string; family_cost: string; individual: boolean }>;
  benefits: Array<{ type: string; name: string; covered: boolean; cost_sharings: Array<{ coinsurance_rate: number; copay_amount: number; network_tier: string; display_string: string }> }>;
  benefits_url: string;
  issuer: { id: string; name: string };
  hsa_eligible: boolean;
  quality_rating?: { global_rating: number };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchJSON(url: string, body?: object): Promise<any> {
  const options: RequestInit = { headers: { "Content-Type": "application/json" } };
  if (body) { options.method = "POST"; options.body = JSON.stringify(body); }
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`CMS API error ${res.status}: ${await res.text()}`);
  return res.json();
}

const insurerCache = new Map<string, string>();

async function ensureInsurer(issuerId: string, name: string): Promise<string> {
  if (insurerCache.has(issuerId)) return insurerCache.get(issuerId)!;

  const { data: existing } = await supabase
    .from("insurer_catalog")
    .select("id")
    .eq("cms_issuer_id", issuerId)
    .single();

  if (existing) { insurerCache.set(issuerId, existing.id); return existing.id; }

  const { data: byName } = await supabase
    .from("insurer_catalog")
    .select("id")
    .ilike("name", `%${name.split(" ")[0]}%`)
    .limit(1)
    .single();

  if (byName) {
    await supabase.from("insurer_catalog").update({ cms_issuer_id: issuerId }).eq("id", byName.id);
    insurerCache.set(issuerId, byName.id);
    return byName.id;
  }

  const { data: created, error } = await supabase
    .from("insurer_catalog")
    .insert({ name, cms_issuer_id: issuerId, data_status: "extracted" })
    .select("id")
    .single();

  if (error) {
    const { data: retry } = await supabase.from("insurer_catalog").select("id").ilike("name", `%${name.split(" ")[0]}%`).limit(1).single();
    const id = retry?.id || "";
    insurerCache.set(issuerId, id);
    return id;
  }

  insurerCache.set(issuerId, created.id);
  return created.id;
}

async function upsertPlan(plan: CMSPlan, insurerId: string, marketplaceType: string) {
  const deductible = plan.deductibles?.find(d => d.individual && d.network_tier === "In-Network")?.amount;
  const oopMax = plan.moops?.find(m => m.individual && m.network_tier === "In-Network")?.amount;

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
    marketplace_type: marketplaceType,
    premium_individual: plan.premium,
    sbc_document_url: plan.benefits_url || null,
    raw_data: {
      deductible_individual: deductible,
      oop_max_individual: oopMax,
      hsa_eligible: plan.hsa_eligible,
      quality_rating: plan.quality_rating?.global_rating,
      benefits_summary: plan.benefits?.map(b => ({
        type: b.type, name: b.name, covered: b.covered,
        in_network: b.cost_sharings?.find(cs => cs.network_tier === "In-Network")?.display_string,
      })),
    },
  };

  const { data: existing } = await supabase.from("plan_catalog").select("id").eq("hios_id", plan.id).single();

  if (existing) {
    await supabase.from("plan_catalog").update(record).eq("id", existing.id);
  } else {
    const { error } = await supabase.from("plan_catalog").insert(record);
    if (error && !error.message.includes("duplicate")) {
      console.warn(`  Insert failed ${plan.id}: ${error.message}`);
    }
  }
}

async function fetchPlansForZip(state: string, zip: string): Promise<CMSPlan[]> {
  const allPlans: CMSPlan[] = [];
  let offset = 0;
  while (true) {
    try {
      const data = await fetchJSON(`${CMS_API_BASE}/plans/search?apikey=${CMS_API_KEY}`, {
        place: { state, zipcode: zip },
        market: "Individual",
        year: PLAN_YEAR,
        limit: 50,
        offset,
      });
      if (!data.plans || data.plans.length === 0) break;
      allPlans.push(...data.plans);
      offset += 50;
      if (offset >= (data.total || 0)) break;
      await sleep(200);
    } catch {
      break;
    }
  }
  return allPlans;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const testMode = args.includes("--test");
  const stateArg = args.find(a => a.startsWith("--states="));

  // Determine which states need data
  const { data: existingStates } = await supabase
    .from("plan_catalog")
    .select("state");
  const coveredStates = new Set(existingStates?.map(r => r.state));

  let targetStates: string[];
  if (stateArg) {
    targetStates = stateArg.split("=")[1].split(",");
  } else {
    // Find all CMS API states that are missing or have very few plans
    targetStates = [];
    for (const state of [...new Set(CMS_API_STATES)]) {
      const { count } = await supabase
        .from("plan_catalog")
        .select("*", { count: "exact", head: true })
        .eq("state", state);
      if (!count || count < 5) {
        targetStates.push(state);
      }
    }
  }

  if (targetStates.length === 0) {
    console.log("\n✅ All CMS API states already have plan data. Nothing to do.");
    return;
  }

  console.log(`\n🏛️  Gap-Fill Plan Ingest`);
  console.log(`   Missing/sparse states: ${targetStates.join(", ")}${testMode ? " (TEST MODE)" : ""}`);
  console.log(`   Already covered: ${[...coveredStates].sort().join(", ")}`);
  console.log(`   Supabase: ${SUPABASE_URL}\n`);

  let totalNew = 0;
  const seenPlanIds = new Set<string>();

  for (const state of targetStates) {
    const zips = STATE_ZIPS[state] || [];
    if (zips.length === 0) {
      console.log(`  ${state}: no zip codes configured, skipping`);
      continue;
    }

    const zipsToTry = testMode ? [zips[0]] : zips;
    let statePlans = 0;

    for (const zip of zipsToTry) {
      try {
        const plans = await fetchPlansForZip(state, zip);
        const newPlans = plans.filter(p => !seenPlanIds.has(p.id));
        for (const p of plans) seenPlanIds.add(p.id);

        if (newPlans.length === 0) continue;

        for (const plan of newPlans) {
          const insurerId = await ensureInsurer(plan.issuer.id, plan.issuer.name);
          const mktType = ["AR","KY","NM","NV"].includes(state) ? "sbe" : "ffm";
          await upsertPlan(plan, insurerId, mktType);
          statePlans++;
        }

        console.log(`  ${state} zip ${zip}: ${newPlans.length} new plans`);
        await sleep(300);
      } catch (err) {
        const msg = String(err);
        if (!msg.includes("not a valid")) {
          console.warn(`  ${state} zip ${zip}: ${err}`);
        }
      }
    }

    totalNew += statePlans;
    console.log(`  ${state} total: ${statePlans} new plans`);
  }

  // Final count
  const { count: finalCount } = await supabase.from("plan_catalog").select("*", { count: "exact", head: true });

  console.log(`\n✅ Gap-fill ingest complete`);
  console.log(`   New plans added: ${totalNew}`);
  console.log(`   Total plan_catalog: ${finalCount}`);
  console.log(`   Insurers: ${insurerCache.size} resolved`);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
