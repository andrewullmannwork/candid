/**
 * DEV-clone seam proof for the unmapped-line-items assign sequence —
 * plans/unmapped_line_items_admin_fix.md (PR-1 accuracy section).
 *
 * Exercises the EXACT write path the admin POST uses (assignUnmappedGroup):
 * proposeNewSignature find-or-create → promote_with_slug RPC (admin_verified) →
 * null-slug line-item stamp → cacheLearnedMapping — against the DEV clone, with
 * a synthetic seeded line item. Proves the RPC contract + write seams pre-PR
 * ([[feedback_empirical_proof_before_pr]]).
 *
 * SAFETY: refuses to run against the PROD project (viahlyugpuviaskpdvce).
 * Cleanup is automatic; pass --keep to leave the seeded row for UI inspection
 * (it then shows up on /admin/pipeline#unmapped in dev — handy for the browser E2E).
 *
 * Run: npx tsx scripts/admin-unmapped-dev-proof.ts [--keep]
 */

import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "../.env.local"), override: true });

import { createClient } from "@supabase/supabase-js";
import { assignUnmappedGroup } from "../src/lib/admin/unmapped-assign";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PROD_REF = "viahlyugpuviaskpdvce";

const SYNTH_CODE = "J9999"; // HCPCS J-code shaped (the REAL PROD row shape), synthetic
const SYNTH_TYPE = "HCPCS"; // bare line vocabulary — identity write must land HCPCS_L2
const SYNTH_DESC = "Dev Proof Synthetic Drug (99999-999-99)";
// prescription_drugs = the Pattern-S-clean target for drug lines (the slug stays the
// pure service; facility-administered context lives in place_of_service, not the slug).
const TARGET_SLUG = "prescription_drugs";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const keep = process.argv.includes("--keep");
  const seedOnly = process.argv.includes("--seed-only"); // seed an UNASSIGNED row for the browser E2E, skip assign + cleanup

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("Missing Supabase env"); process.exit(1);
  }
  if (SUPABASE_URL.includes(PROD_REF)) {
    console.error(`REFUSING to run: NEXT_PUBLIC_SUPABASE_URL points at PROD (${PROD_REF}). Switch to dev (scripts/use-db.sh dev).`);
    process.exit(1);
  }
  console.log(`\nDEV project: ${SUPABASE_URL.replace("https://", "").split(".")[0]} — proceeding\n`);

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Target slug must exist (it's a real catalog row on the clone)
  const { data: slugRow } = await supabase.from("service_catalog").select("slug").eq("slug", TARGET_SLUG).maybeSingle();
  if (!slugRow) { console.error(`Catalog slug ${TARGET_SLUG} missing on dev — pick another`); process.exit(1); }

  // Admin actor (promote RPC records it)
  const { data: adminUser } = await supabase.from("users").select("id").eq("is_admin", true).limit(1).maybeSingle();
  if (!adminUser) { console.error("No admin user on dev clone"); process.exit(1); }

  // Seed: attach a synthetic null-slug line item to any existing claim
  const { data: claim } = await supabase.from("claims").select("id").limit(1).maybeSingle();
  if (!claim) { console.error("No claims on dev clone to attach to"); process.exit(1); }

  const { data: seeded, error: seedErr } = await supabase
    .from("claim_line_items")
    .insert({
      claim_id: claim.id,
      line_number: 999,
      billing_code: SYNTH_CODE,
      billing_code_type: SYNTH_TYPE,
      description: SYNTH_DESC,
      service_slug: null,
      billed_amount: 1,
    })
    .select("id")
    .single();
  if (seedErr || !seeded) { console.error("Seed insert failed:", seedErr?.message); process.exit(1); }
  console.log(`Seeded line item ${seeded.id} on claim ${claim.id.slice(0, 8)}…\n`);

  if (seedOnly) {
    console.log("--seed-only: row left UNASSIGNED for the browser E2E.");
    console.log(`It should appear on /admin/pipeline#unmapped as "${SYNTH_DESC}" (NDC ${SYNTH_CODE}).`);
    console.log(`Cleanup after the E2E: re-run without flags (full proof + cleanup) or delete line item ${seeded.id}.`);
    process.exit(0);
  }

  // ── Run the exact assign sequence the route uses ──
  const result = await assignUnmappedGroup(supabase, {
    billingCode: SYNTH_CODE,
    codeType: SYNTH_TYPE,
    description: SYNTH_DESC,
    serviceSlug: TARGET_SLUG,
    actorUserId: adminUser.id,
  });

  console.log("— assign result —");
  assert("assign ok", result.ok, !result.ok ? `${result.status}: ${result.error}` : undefined);
  if (result.ok) {
    assert("updatedCount ≥ 1", result.updatedCount >= 1, `got ${result.updatedCount}`);
    assert("identityId returned", !!result.identityId);
  }

  console.log("\n— DB state after assign —");
  const { data: li } = await supabase
    .from("claim_line_items")
    .select("service_slug, billing_code_identity_id")
    .eq("id", seeded.id)
    .single();
  assert("line item slug stamped", li?.service_slug === TARGET_SLUG, `got ${li?.service_slug}`);
  assert("line item linked to identity", !!li?.billing_code_identity_id);

  const identityId = result.ok ? result.identityId : null;
  const { data: ident } = identityId
    ? await supabase.from("billing_code_identity").select("promotion_state, service_slug, billing_code_type").eq("id", identityId).single()
    : { data: null };
  assert("identity admin_verified", ident?.promotion_state === "admin_verified", `got ${ident?.promotion_state}`);
  assert("identity slug set", ident?.service_slug === TARGET_SLUG, `got ${ident?.service_slug}`);
  assert("identity type HCPCS_L2 (bridged from bare HCPCS)", ident?.billing_code_type === "HCPCS_L2", `got ${ident?.billing_code_type}`);

  const { data: cache } = await supabase
    .from("billing_code_mappings")
    .select("service_slug, confidence")
    .eq("billing_code", SYNTH_CODE)
    .eq("billing_code_type", SYNTH_TYPE) // cache keyed by the RAW line vocabulary
    .eq("service_slug", TARGET_SLUG)
    .maybeSingle();
  assert("resolver cache row written", !!cache, "billing_code_mappings row missing");

  // ── Cleanup ──
  if (keep) {
    console.log("\n--keep: leaving seeded rows for UI inspection (delete the line item + identity + cache row after).");
  } else {
    console.log("\nCleaning up…");
    await supabase.from("claim_line_items").delete().eq("id", seeded.id);
    await supabase.from("billing_code_mappings").delete().eq("billing_code", SYNTH_CODE);
    if (identityId) {
      const { error: identDelErr } = await supabase.from("billing_code_identity").delete().eq("id", identityId);
      if (identDelErr) console.log(`  (identity row kept — ${identDelErr.message}; synthetic + harmless on dev)`);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
