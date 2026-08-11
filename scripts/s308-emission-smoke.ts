/**
 * S308 — headless emission smoke: the REAL acupuncture pcs row through the REAL
 * loaders + engine. Proves the answered-row emission (code) independently of
 * the dev server's bundle state. Read-only.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { loadCoverageMapForPlan } from "../src/lib/audit/coverage-loader";
import { buildServiceCostShare, EMPTY_PLAN_COST_SHARE_PARAMS } from "../src/lib/claims/cost-share-loader";
import { computeCostShareV2 } from "../src/lib/claims/recovery-math";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const PLAN = "de086649-a32a-4823-9f8e-5ffefc218784";

async function main() {
  const map = await loadCoverageMapForPlan(sb, PLAN);
  const cov = map?.get("acupuncture") ?? null;
  console.log("coverage row:", JSON.stringify(cov));
  const service = buildServiceCostShare(cov, true);
  console.log("service.userStatedRate:", service?.userStatedRate, "costProvenance:", service?.costProvenance);
  const r = computeCostShareV2({
    line: { billed: 1500, allowed: 1500, insuranceAdjusted: 0, patientPaid: 0, patientResponsibility: 1500 },
    service,
    insurer: { memberAppliedToDeductible: null, memberCoinsurance: null, memberCopay: null, deniedAmount: null, insurancePaid: null },
    plan: EMPTY_PLAN_COST_SHARE_PARAMS,
    accumulator: null,
    overrides: { deductibleMet: null, deductibleMetAsOf: null, oopMet: null, oopMetAsOf: null, userNetworkOverride: null },
    networkLine: "in_network",
    networkClaim: null,
    minRecovery: 1,
    preventive: { isPreventive: false, acaStatus: "unknown" },
  });
  console.log("assumptions:", JSON.stringify(r.assumptions, null, 1));
}
main().catch((e) => { console.error("SMOKE FAIL:", e.message); process.exit(1); });
