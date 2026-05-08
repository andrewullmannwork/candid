/**
 * S71 PROD cleanup — run AFTER the S71 PR (CF-19 + CF-25 + CF-20) merges to main.
 *
 * Repairs two corrupted-row situations surfaced during S71 investigation:
 *
 *   1. CF-19 — andrew.david.ullmann@gmail.com (user 2ce55772) active plan 38a33b4f
 *      has degraded plan-identity values from successive smart-skip re-uploads
 *      (in_ded(ind/fam): 0/2000 ← asymmetric; in_oop(ind/fam): 0/2000 ← wrong;
 *      out_ded(ind/fam): 2000/null; out_oop(ind/fam): 3000/null).
 *      Reset the IN-network values + family OON values to the correct
 *      full-extraction shape from the older inactive plan 6d17611e (same SBC,
 *      pre-degradation): in_ded ind/fam $0/$0; in_oop ind/fam $3000/$6000;
 *      out_ded ind/fam $2000/$4000; out_oop ind/fam $6000/$12000. Drop the
 *      stale `canonical_inherited` provenance entries on the IN columns so
 *      consumer-read filter no longer renders them as Community badge state
 *      with phantom inheritance — Hidden + page-level upload prompt is the
 *      honest signal until next re-upload writes cite-grade provenance.
 *
 *   2. CF-25 — andrewullmann4@gmail.com (user ac563af7) has TWO active rows:
 *      c67a7d6f (sbc_upload, full doc_extraction provenance, correct values)
 *      AND 372ba71c (manual, no provenance, profile-form values).
 *      profiles.active_insurance_plan_id points at the manual one. Result:
 *      dashboard renders manual data with no badges → "Showing common benefits"
 *      banner. Cleanup: deactivate 372ba71c (the manual plan) + repoint
 *      profile.active_insurance_plan_id → c67a7d6f (the SBC plan).
 *      Pattern 1 #10 honored — no hard deletes; manual row marked is_active=false.
 *
 * Idempotent: re-running has no effect once both repairs land.
 *
 * Usage:
 *   npx tsx scripts/s71-prod-cleanup.ts --dry-run    (default; show planned writes)
 *   npx tsx scripts/s71-prod-cleanup.ts --apply       (commit changes to PROD)
 */

import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(__dirname, "../.env.local"), override: true });

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Missing Supabase env. Aborting.");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const APPLY = process.argv.includes("--apply");
const DRY_RUN = !APPLY;

// ── Targets identified during S71 investigation ────────────────────────────
const ANDREW_MAIN_USER_ID = "2ce55772-bdf1-4edd-bd16-215aa239990e";
const ANDREW_MAIN_ACTIVE_PLAN_ID = "38a33b4f-25dd-4b5e-bf2c-605074bd6ca8";

const ANDREW_4_USER_ID = "ac563af7-b6c9-4a98-bb98-86e56d27a945";
const ANDREW_4_MANUAL_PLAN_ID = "372ba71c-6783-4a8a-a809-064434529b0a";
const ANDREW_4_SBC_PLAN_ID = "c67a7d6f-aa4e-4126-895c-9cb49c39571e";

// Correct full-extraction values for the Cigna OAP SBC (sourced from the older
// inactive plan 6d17611e on Andrew main's account, which was created by the
// full Haiku SBC parser before smart-skip degradation set in).
const CIGNA_OAP_CORRECT = {
  in_deductible_individual: 0,
  in_deductible_family: 0,
  in_oop_max_individual: 3000,
  in_oop_max_family: 6000,
  out_deductible_individual: 2000,
  out_deductible_family: 4000,
  out_oop_max_individual: 6000,
  out_oop_max_family: 12000,
};

function hr(label: string) {
  console.log(`\n${"=".repeat(80)}\n  ${label}\n${"=".repeat(80)}`);
}

async function main() {
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN (use --apply to commit)"}\n`);

  // ── CF-19 cleanup ─────────────────────────────────────────────────────────
  hr("CF-19 — repair Andrew main's degraded plan-identity values");

  const { data: planBefore, error: pErr } = await sb
    .from("insurance_plans")
    .select("id, user_id, in_deductible_individual, in_deductible_family, in_oop_max_individual, in_oop_max_family, out_deductible_individual, out_deductible_family, out_oop_max_individual, out_oop_max_family, field_provenance")
    .eq("id", ANDREW_MAIN_ACTIVE_PLAN_ID)
    .maybeSingle();
  if (pErr || !planBefore) {
    console.error(`Plan ${ANDREW_MAIN_ACTIVE_PLAN_ID} not found:`, pErr?.message);
  } else if (planBefore.user_id !== ANDREW_MAIN_USER_ID) {
    console.error(`Plan owner mismatch — refusing to write. expected user ${ANDREW_MAIN_USER_ID}, got ${planBefore.user_id}`);
  } else {
    console.log(`Before: in_ded(ind/fam)=${planBefore.in_deductible_individual}/${planBefore.in_deductible_family} · in_oop(ind/fam)=${planBefore.in_oop_max_individual}/${planBefore.in_oop_max_family} · out_ded(ind/fam)=${planBefore.out_deductible_individual}/${planBefore.out_deductible_family} · out_oop(ind/fam)=${planBefore.out_oop_max_individual}/${planBefore.out_oop_max_family}`);

    // Strip stale canonical_inherited provenance entries for the IN-network
    // plan-identity fields. The new code path (CF-19 fix in extraction-dedup.ts)
    // won't re-create these on next upload because Haiku Important Questions on
    // the Cigna OAP SBC reliably extracts in-network values (verified during
    // probe — see ac563af7's c67a7d6f field_provenance dump). So clearing them
    // now hands display state cleanly to either Hidden (if next render reads
    // pre-re-upload) or User Verified cite-grade (post next re-upload).
    const fp = (planBefore.field_provenance ?? {}) as Record<string, unknown>;
    const fpCleaned: Record<string, unknown> = {};
    const inNetworkKeys = new Set([
      "in_deductible_individual",
      "in_deductible_family",
      "in_oop_max_individual",
      "in_oop_max_family",
      "out_deductible_family",
      "out_oop_max_family",
    ]);
    for (const [k, v] of Object.entries(fp)) {
      const entry = v as { source?: string } | null;
      if (inNetworkKeys.has(k) && entry?.source === "canonical_inherited") {
        // drop — values get reset; provenance will be rewritten on next upload
        continue;
      }
      fpCleaned[k] = v;
    }

    const update = {
      ...CIGNA_OAP_CORRECT,
      field_provenance: fpCleaned,
    };
    console.log(`After:  in_ded(ind/fam)=${update.in_deductible_individual}/${update.in_deductible_family} · in_oop(ind/fam)=${update.in_oop_max_individual}/${update.in_oop_max_family} · out_ded(ind/fam)=${update.out_deductible_individual}/${update.out_deductible_family} · out_oop(ind/fam)=${update.out_oop_max_individual}/${update.out_oop_max_family}`);
    console.log(`field_provenance entries stripped: ${Object.keys(fp).length - Object.keys(fpCleaned).length}`);

    if (APPLY) {
      const { error: updErr } = await sb
        .from("insurance_plans")
        .update(update)
        .eq("id", ANDREW_MAIN_ACTIVE_PLAN_ID)
        .eq("user_id", ANDREW_MAIN_USER_ID);
      if (updErr) {
        console.error("CF-19 UPDATE failed:", updErr.message);
      } else {
        console.log("✅ CF-19 UPDATE applied");
      }
    } else {
      console.log("(dry run — no write)");
    }
  }

  // ── CF-25 cleanup ─────────────────────────────────────────────────────────
  hr("CF-25 — deactivate andrewullmann4's manual plan + repoint profile to SBC plan");

  // Sanity check: confirm both plans exist and belong to the right user.
  const { data: bothPlans } = await sb
    .from("insurance_plans")
    .select("id, user_id, source, is_active")
    .in("id", [ANDREW_4_MANUAL_PLAN_ID, ANDREW_4_SBC_PLAN_ID]);
  if (!bothPlans || bothPlans.length !== 2) {
    console.error("Could not load both plans; aborting CF-25 cleanup.");
  } else {
    const manual = bothPlans.find((p) => p.id === ANDREW_4_MANUAL_PLAN_ID);
    const sbc = bothPlans.find((p) => p.id === ANDREW_4_SBC_PLAN_ID);
    const ownerOk =
      manual?.user_id === ANDREW_4_USER_ID && sbc?.user_id === ANDREW_4_USER_ID;
    if (!ownerOk) {
      console.error("Owner mismatch on one or both rows — refusing to write.");
    } else {
      console.log(`Manual plan (${ANDREW_4_MANUAL_PLAN_ID}): source=${manual?.source}, is_active=${manual?.is_active}`);
      console.log(`SBC plan    (${ANDREW_4_SBC_PLAN_ID}): source=${sbc?.source}, is_active=${sbc?.is_active}`);

      // Idempotency: if profile already points at SBC plan AND manual is already
      // inactive, nothing to do.
      const { data: profile } = await sb
        .from("profiles")
        .select("active_insurance_plan_id")
        .eq("user_id", ANDREW_4_USER_ID)
        .maybeSingle();
      const profilePointsAtSBC = profile?.active_insurance_plan_id === ANDREW_4_SBC_PLAN_ID;
      const manualAlreadyInactive = manual?.is_active === false;

      if (profilePointsAtSBC && manualAlreadyInactive) {
        console.log("✅ Already in target state — no writes needed.");
      } else {
        console.log("Planned writes:");
        console.log(`  insurance_plans[${ANDREW_4_MANUAL_PLAN_ID}].is_active = false`);
        console.log(`  profiles[user=${ANDREW_4_USER_ID}].active_insurance_plan_id = ${ANDREW_4_SBC_PLAN_ID}`);

        if (APPLY) {
          const { error: deactErr } = await sb
            .from("insurance_plans")
            .update({ is_active: false })
            .eq("id", ANDREW_4_MANUAL_PLAN_ID)
            .eq("user_id", ANDREW_4_USER_ID);
          if (deactErr) {
            console.error("Manual deactivate failed:", deactErr.message);
          } else {
            console.log("✅ manual plan deactivated");
          }

          const { error: profileErr } = await sb
            .from("profiles")
            .update({ active_insurance_plan_id: ANDREW_4_SBC_PLAN_ID })
            .eq("user_id", ANDREW_4_USER_ID);
          if (profileErr) {
            console.error("Profile repoint failed:", profileErr.message);
          } else {
            console.log("✅ profile repointed to SBC plan");
          }
        } else {
          console.log("(dry run — no writes)");
        }
      }
    }
  }

  hr("DONE");
  if (DRY_RUN) {
    console.log("Re-run with --apply to commit the changes above.");
  }
}

main().catch((e) => {
  console.error("Cleanup script failed:", e);
  process.exit(1);
});
