/**
 * Fixture for PR-2 — NDC drug-line auto-classification
 * (plans/unmapped_line_items_admin_fix.md, Accuracy section).
 *
 * Pre-declared pass criteria:
 *   • OFF (default config) = byte-identical — null resolutions unchanged AND the
 *     prompt carries no NDC guidance (the config key gates the PROMPT too, S184).
 *   • ON: facility-NDC set (incl. the 3 REAL items from the 2026-07-15 alert)
 *     ≥90% → prescription_drugs via source "ndc_default" @ configured confidence.
 *   • ON: a confident Haiku tier-slug match (retail fill) ALWAYS wins over the default.
 *   • ON: non-NDC lines never touched by the fallback (no over-fire).
 *   • Graceful: catalog without prescription_drugs → falls back to null, never throws.
 *
 * Haiku is stubbed via opts.haikuCall (no API spend); learned-cache reads hit the
 * DEV clone and miss (synthetic codes). Manually runnable per Ship Gate G4.
 *
 * Run: npx tsx scripts/ndc-auto-classify-fixture.ts
 */

import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "../.env.local"), override: true });

import { createClient } from "@supabase/supabase-js";
import {
  resolveServices,
  buildResolverPrompt,
  parseResolverConfig,
  DEFAULT_RESOLVER_CONFIG,
  type CatalogEntry,
  type ResolveLineInput,
} from "../src/lib/claims/service-resolver";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PROD_REF = "viahlyugpuviaskpdvce";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const CATALOG: CatalogEntry[] = [
  { slug: "prescription_drugs", name: "Prescription Drugs", description: "Drug charges", category: "rx", conceptId: null },
  { slug: "generic_rx_tier1", name: "Generic Drugs (Tier 1)", description: "Retail generic fills", category: "rx", conceptId: null },
  { slug: "pcp_visit", name: "Primary Care Visit", description: "Office visit", category: "office_visit", conceptId: null },
];

// The 3 REAL unmapped items from the alert (facility-administered) + a synthetic 4th
const FACILITY_NDC: ResolveLineInput[] = [
  { lineNumber: 1, description: "Lidocaine 2 % Soln (63323-486-02)", billingCode: "63323-486-02", billingCodeType: "NDC" },
  { lineNumber: 2, description: "Propofol 10 Mg (25021-608-20)", billingCode: "25021-608-20", billingCodeType: "NDC" },
  { lineNumber: 3, description: "Lactated Ringers Soln (0338-0117-04)", billingCode: "0338-0117-04", billingCodeType: "NDC" },
  { lineNumber: 4, description: "Sodium Chloride 0.9% IV Soln (88888-888-88)", billingCode: "88888-888-88", billingCodeType: "NDC" },
];
const RETAIL_NDC: ResolveLineInput = { lineNumber: 5, description: "ATORVASTATIN 20MG 30-DAY SUPPLY (77777-777-77)", billingCode: "77777-777-77", billingCodeType: "NDC" };
const NON_NDC: ResolveLineInput = { lineNumber: 6, description: "MYSTERY UNMATCHABLE THING XZQ", billingCode: "99999", billingCodeType: "CPT" };

const haikuNull = async () => ({ matches: [] });
const ON = { ...DEFAULT_RESOLVER_CONFIG, ndcDefaultEnabled: true };
const OFF = { ...DEFAULT_RESOLVER_CONFIG };

async function main() {
  if (SUPABASE_URL.includes(PROD_REF)) { console.error("REFUSING: env points at PROD"); process.exit(1); }
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const base = { supabase, userId: "", trustTieredCache: false, skipWriteback: true, emitModifiers: false, catalog: CATALOG } as const;

  console.log("\n— config parsing —");
  {
    const c = parseResolverConfig({ ndc_default_enabled: true, ndc_default_confidence: 0.8 });
    assert("keys parsed", c.ndcDefaultEnabled === true && c.ndcDefaultConfidence === 0.8);
    const d = parseResolverConfig({ ndc_default_enabled: "yes", ndc_default_confidence: 7 });
    assert("garbage ignored → defaults", d.ndcDefaultEnabled === false && d.ndcDefaultConfidence === 0.75);
    assert("DEFAULT is OFF", DEFAULT_RESOLVER_CONFIG.ndcDefaultEnabled === false);
  }

  console.log("\n— prompt gating (the key gates the PROMPT too) —");
  {
    const off = buildResolverPrompt(CATALOG, FACILITY_NDC).systemPrompt;
    const offDefault = buildResolverPrompt(CATALOG, FACILITY_NDC, false).systemPrompt;
    const on = buildResolverPrompt(CATALOG, FACILITY_NDC, true).systemPrompt;
    assert("OFF prompt has no NDC guidance", !off.includes("NDC-coded lines"));
    assert("omitted param === false param (byte-identical)", off === offDefault);
    assert("ON prompt carries the guidance inside Rules", on.includes("NDC-coded lines are DRUGS"));
  }

  console.log("\n— OFF = byte-identical resolutions —");
  {
    const res = await resolveServices([...FACILITY_NDC, NON_NDC], { ...base, config: OFF, haikuCall: haikuNull });
    assert("facility NDC stays null when OFF", FACILITY_NDC.every((l) => res.get(l.lineNumber)?.slug === null));
    assert("source stays none when OFF", FACILITY_NDC.every((l) => res.get(l.lineNumber)?.source === "none"));
  }

  console.log("\n— ON: facility-NDC accuracy set (target ≥90%) —");
  {
    const res = await resolveServices(FACILITY_NDC, { ...base, config: ON, haikuCall: haikuNull });
    const hits = FACILITY_NDC.filter((l) => {
      const r = res.get(l.lineNumber);
      return r?.slug === "prescription_drugs" && r.source === "ndc_default" && r.confidence === 0.75;
    });
    assert(`facility set → prescription_drugs (${hits.length}/${FACILITY_NDC.length})`, hits.length === FACILITY_NDC.length);
    assert("needsReview false at 0.75 (≥ review floor)", FACILITY_NDC.every((l) => res.get(l.lineNumber)?.needsReview === false));
  }

  console.log("\n— ON: confident Haiku tier match WINS (retail) —");
  {
    const haikuRetail = async () => ({ matches: [{ lineNumber: 5, slug: "generic_rx_tier1", confidence: 0.9 }] });
    const res = await resolveServices([RETAIL_NDC], { ...base, config: ON, haikuCall: haikuRetail });
    const r = res.get(5);
    assert("retail fill → tier slug via haiku", r?.slug === "generic_rx_tier1" && r.source === "haiku");
  }

  console.log("\n— ON: low-confidence Haiku falls to the default —");
  {
    const haikuWeak = async () => ({ matches: [{ lineNumber: 1, slug: "generic_rx_tier1", confidence: 0.4 }] });
    const res = await resolveServices([FACILITY_NDC[0]], { ...base, config: ON, haikuCall: haikuWeak });
    const r = res.get(1);
    assert("0.4 < floor → ndc_default fires", r?.slug === "prescription_drugs" && r.source === "ndc_default");
  }

  console.log("\n— ON: no over-fire —");
  {
    const res = await resolveServices([NON_NDC], { ...base, config: ON, haikuCall: haikuNull });
    assert("non-NDC unresolved stays null", res.get(6)?.slug === null && res.get(6)?.source === "none");
  }

  console.log("\n— ON: graceful when catalog lacks the default slug —");
  {
    const thinCatalog = CATALOG.filter((c) => c.slug !== "prescription_drugs");
    const res = await resolveServices([FACILITY_NDC[0]], { ...base, config: ON, catalog: thinCatalog, haikuCall: haikuNull });
    assert("missing slug → null, no throw", res.get(1)?.slug === null);
  }

  console.log("\n— ON + skipHaiku path —");
  {
    const res = await resolveServices([FACILITY_NDC[1]], { ...base, config: ON, skipHaiku: true });
    const r = res.get(2);
    assert("skipHaiku terminal also applies the default", r?.slug === "prescription_drugs" && r.source === "ndc_default");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
