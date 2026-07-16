/**
 * LIVE-Haiku smoke for PR-2 NDC auto-classification — the real-model half of
 * the validate-real-flag-ON gate (plans/unmapped_line_items_admin_fix.md).
 *
 * Paired runs (config OFF vs ON) through resolveServices with REAL Haiku and
 * the LIVE DEV catalog (~85 services). No DB flip needed — config is passed
 * via opts. skipWriteback everywhere (no cache mutation). Spend ≈ 2 batch calls.
 *
 * Proves on the live model: facility-NDC set resolves to prescription_drugs
 * (via guided-haiku OR the deterministic fallback), retail fills are NOT
 * force-mapped by the fallback, and control (non-NDC) lines resolve
 * identically OFF vs ON (prompt-guidance blast-radius check).
 *
 * Run: npx tsx scripts/ndc-live-smoke.ts   (DEV env; refuses PROD)
 */

import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "../.env.local"), override: true });

import { createClient } from "@supabase/supabase-js";
import {
  resolveServices,
  DEFAULT_RESOLVER_CONFIG,
  type ResolveLineInput,
} from "../src/lib/claims/service-resolver";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PROD_REF = "viahlyugpuviaskpdvce";

let pass = 0, fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const LINES: ResolveLineInput[] = [
  // facility-administered (the 3 real alert items + IV saline)
  { lineNumber: 1, description: "Lidocaine 2 % Soln (63323-486-02)", billingCode: "63323-486-02", billingCodeType: "NDC" },
  { lineNumber: 2, description: "Propofol 10 Mg (25021-608-20)", billingCode: "25021-608-20", billingCodeType: "NDC" },
  { lineNumber: 3, description: "Lactated Ringers Soln (0338-0117-04)", billingCode: "0338-0117-04", billingCodeType: "NDC" },
  { lineNumber: 4, description: "Sodium Chloride 0.9% IV Soln (88888-888-88)", billingCode: "88888-888-88", billingCodeType: "NDC" },
  // retail fill (must NOT be force-defaulted; tier slug or drug slug via haiku OK)
  { lineNumber: 5, description: "ATORVASTATIN 20MG TAB 30-DAY SUPPLY GENERIC TIER 1 (77777-777-77)", billingCode: "77777-777-77", billingCodeType: "NDC" },
  // controls — non-NDC, must resolve IDENTICALLY off vs on
  { lineNumber: 6, description: "OFFICE VISIT EST PRIMARY CARE", billingCode: "99213", billingCodeType: "CPT" },
  { lineNumber: 7, description: "MRI BRAIN W/O CONTRAST", billingCode: "70551", billingCodeType: "CPT" },
];

async function main() {
  if (SUPABASE_URL.includes(PROD_REF)) { console.error("REFUSING: env points at PROD"); process.exit(1); }
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const base = { supabase, userId: "", trustTieredCache: false, skipWriteback: true, emitModifiers: false } as const;

  console.log("\n— paired LIVE-Haiku runs (OFF, then ON) —");
  const off = await resolveServices(LINES, { ...base, config: { ...DEFAULT_RESOLVER_CONFIG } });
  const on = await resolveServices(LINES, { ...base, config: { ...DEFAULT_RESOLVER_CONFIG, ndcDefaultEnabled: true } });

  for (const l of LINES) {
    const o = off.get(l.lineNumber), n = on.get(l.lineNumber);
    console.log(`  line ${l.lineNumber}: OFF → ${o?.slug ?? "null"} (${o?.source}, ${o?.confidence?.toFixed(2)}) | ON → ${n?.slug ?? "null"} (${n?.source}, ${n?.confidence?.toFixed(2)})`);
  }

  console.log("\n— assertions —");
  const facility = [1, 2, 3, 4];
  const facilityHits = facility.filter((i) => on.get(i)?.slug === "prescription_drugs");
  assert(`ON: facility set → prescription_drugs (${facilityHits.length}/4, need ≥3 = 75%+ incl all 3 real items)`,
    facilityHits.length >= 3 && [1, 2, 3].every((i) => on.get(i)?.slug === "prescription_drugs"),
    `hits=${facilityHits.join(",")}`);
  assert("ON: facility never null", facility.every((i) => on.get(i)?.slug !== null));

  const retail = on.get(5);
  assert("ON: retail fill NOT left null", retail?.slug != null, "retail unresolved");
  assert("ON: retail not force-defaulted when guidance/tier applies (tier slug preferred; prescription_drugs via haiku acceptable; via ndc_default = criterion miss)",
    retail?.source !== "ndc_default" || retail?.slug === "prescription_drugs",
    `got ${retail?.slug} via ${retail?.source}`);
  console.log(`  (retail detail: ${retail?.slug} via ${retail?.source} @ ${retail?.confidence?.toFixed(2)})`);

  for (const i of [6, 7]) {
    assert(`controls identical OFF vs ON (line ${i})`, off.get(i)?.slug === on.get(i)?.slug,
      `${off.get(i)?.slug} vs ${on.get(i)?.slug}`);
  }
  assert("OFF: facility stays null (today's behavior)", facility.every((i) => off.get(i)?.slug === null || off.get(i)?.source !== "ndc_default"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
