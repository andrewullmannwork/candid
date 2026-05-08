/**
 * S71 investigation — CF-19 (in-network $0 root cause) + CF-25 (uploaded plan_doc
 * not propagating to Verified state) data trace.
 *
 * Read-only. Uses service-role key. Does not write or modify any rows.
 *
 * Targets the two test emails surfaced in CF tracking:
 *   - andrew.david.ullmann@gmail.com    (CF-19 main test account)
 *   - andrewullmann4@gmail.com          (CF-25 — "0/38 benefits checked" + "Unverified")
 *
 * Usage:
 *   npx tsx scripts/s71-investigation.ts
 */

import { config } from "dotenv";
import { resolve } from "path";

// Load env BEFORE importing modules that use env at construction time
config({ path: resolve(__dirname, "../.env.local"), override: true });

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE env. Aborting.");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const TEST_EMAILS = [
  "andrew.david.ullmann@gmail.com",
  "andrewullmann4@gmail.com",
];

function hr(label: string) {
  console.log(`\n${"=".repeat(80)}\n  ${label}\n${"=".repeat(80)}`);
}

function sub(label: string) {
  console.log(`\n--- ${label} ---`);
}

async function main() {
  hr("STEP 1 — All profile rows (auth.admin not returning users; pivoting to profiles as discovery)");

  const { data: allProfiles, error: profErr } = await sb
    .from("profiles")
    .select("*")
    .order("created_at", { ascending: false });
  if (profErr) console.error("profiles query error:", profErr.message);
  console.log(`Total profiles: ${allProfiles?.length || 0}`);
  for (const p of (allProfiles || []) as Array<Record<string, unknown>>) {
    console.log(`  ${p.user_id} | ${p.insurer || "—"} / ${p.plan_name || "—"} | active_plan=${p.active_insurance_plan_id || "—"} | dependents=${JSON.stringify(p.dependents) || "—"}`);
  }

  // Cross-reference users table for email_verified + phone_verified
  if (allProfiles && allProfiles.length > 0) {
    const userIds = (allProfiles as Array<{ user_id: string }>).map((p) => p.user_id);
    const { data: usersRows, error: uErr } = await sb
      .from("users")
      .select("*")
      .in("id", userIds);
    if (uErr) console.error("users query error:", uErr.message);
    console.log(`\nusers table cross-ref:`);
    for (const u of (usersRows || []) as Array<Record<string, unknown>>) {
      console.log(`  ${u.id} | email=${u.email || "—"} | email_verified=${u.email_verified} | phone=${u.phone_e164 || "—"} | phone_verified=${u.phone_verified}`);
    }
  }

  const userIdByEmail = new Map<string, string>();
  for (const p of allProfiles || []) {
    userIdByEmail.set(p.user_id, p.user_id); // key is user_id; we don't have emails
  }

  if (userIdByEmail.size === 0) {
    console.error("No profiles found. Abort.");
    return;
  }

  for (const [email, userId] of userIdByEmail) {
    hr(`STEP 2 — User dump: ${email}  (${userId})`);

    sub("profiles row");
    const { data: profile } = await sb
      .from("profiles")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    console.log(JSON.stringify(profile, null, 2));

    sub("documents (5 most recent; classification + status + linkage)");
    const { data: docs } = await sb
      .from("documents")
      .select("id, file_name, file_hash, classified_type, classification_confidence, status, processing_step, linked_insurance_plan_id, purpose, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(5);
    console.log(JSON.stringify(docs, null, 2));

    sub("insurance_plans rows (all; active first)");
    const { data: ipRows } = await sb
      .from("insurance_plans")
      .select("id, plan_name, insurer_name, plan_type, plan_year, source, source_document_id, is_active, canonical_plan_id, verification_status, in_deductible_individual, in_deductible_family, in_oop_max_individual, in_oop_max_family, out_deductible_individual, out_deductible_family, out_oop_max_individual, out_oop_max_family, field_provenance, created_at, updated_at")
      .eq("user_id", userId)
      .order("is_active", { ascending: false })
      .order("created_at", { ascending: false });
    console.log(`Total rows: ${ipRows?.length || 0}`);
    if (ipRows && ipRows.length > 0) {
      for (const p of ipRows) {
        console.log(`\n  [${p.is_active ? "ACTIVE" : "inactive"}] ${p.id}`);
        console.log(`    ${p.insurer_name} / ${p.plan_name} (${p.plan_type}, ${p.plan_year}) source=${p.source} canonical=${p.canonical_plan_id} verify=${p.verification_status}`);
        console.log(`    in_ded(ind/fam): ${p.in_deductible_individual}/${p.in_deductible_family}  oop(ind/fam): ${p.in_oop_max_individual}/${p.in_oop_max_family}`);
        console.log(`    out_ded(ind/fam): ${p.out_deductible_individual}/${p.out_deductible_family}  oop(ind/fam): ${p.out_oop_max_individual}/${p.out_oop_max_family}`);
        const fp = p.field_provenance as Record<string, unknown> | null;
        if (fp && typeof fp === "object") {
          console.log(`    field_provenance keys: [${Object.keys(fp).join(", ")}]`);
          // Print provenance details for the 4 plan-identity numeric fields under investigation
          for (const k of ["in_deductible_individual", "in_oop_max_individual", "out_deductible_individual", "out_oop_max_individual"]) {
            if (fp[k]) {
              console.log(`    ${k} prov: ${JSON.stringify(fp[k])}`);
            }
          }
        } else {
          console.log(`    field_provenance: NULL`);
        }
      }
    }

    sub("plan_covered_services count for active plan");
    if (profile?.active_insurance_plan_id) {
      const { count } = await sb
        .from("plan_covered_services")
        .select("*", { count: "exact", head: true })
        .eq("insurance_plan_id", profile.active_insurance_plan_id);
      console.log(`  active plan ${profile.active_insurance_plan_id}: ${count} plan_covered_services rows`);
    } else {
      console.log(`  no active_insurance_plan_id set on profile`);
    }
  }

  hr("STEP 3 — Canonical plans referenced by these users + verification_count");

  // Collect distinct canonical_plan_ids referenced by these users
  const { data: allUserPlans } = await sb
    .from("insurance_plans")
    .select("canonical_plan_id, user_id")
    .in("user_id", Array.from(userIdByEmail.values()));
  const canonicalIds = new Set(
    (allUserPlans || []).map((r) => r.canonical_plan_id).filter(Boolean) as string[]
  );

  for (const cId of canonicalIds) {
    const { data: c } = await sb
      .from("canonical_plans")
      .select("id, plan_name, insurer_id, plan_type, plan_year, state, deductible_individual, oop_max_individual, premium_monthly, extraction_count, extraction_stable, haiku_output_stable, verification_count, source")
      .eq("id", cId)
      .maybeSingle();
    if (!c) {
      console.log(`\nCanonical ${cId}: NOT FOUND`);
      continue;
    }
    sub(`Canonical ${cId}: ${c.plan_name} (${c.plan_type}, ${c.plan_year}, state=${c.state})`);
    console.log(JSON.stringify(c, null, 2));

    // Distinct uploaders (any user) who linked an insurance_plans row to this canonical
    const { data: uploaders } = await sb
      .from("insurance_plans")
      .select("user_id, source, source_document_id, is_active, created_at")
      .eq("canonical_plan_id", cId);
    const distinctUsers = new Set((uploaders || []).map((u) => u.user_id));
    console.log(`  distinct user uploaders: ${distinctUsers.size}`);
    console.log(`  total insurance_plans rows pointing at this canonical: ${uploaders?.length || 0}`);

    // canonical_plan_services count + sample
    const { count: cpsCount } = await sb
      .from("canonical_plan_services")
      .select("*", { count: "exact", head: true })
      .eq("canonical_plan_id", cId);
    console.log(`  canonical_plan_services rows: ${cpsCount}`);

    // Document file_hashes pointing at this canonical (via insurance_plans)
    const docIds = (uploaders || []).map((u) => u.source_document_id).filter(Boolean) as string[];
    if (docIds.length > 0) {
      const { data: hashes } = await sb
        .from("documents")
        .select("id, file_hash, classified_type, status, user_id")
        .in("id", docIds);
      const hashSet = new Set((hashes || []).map((d) => d.file_hash).filter(Boolean));
      console.log(`  distinct file_hashes among source documents: ${hashSet.size} (out of ${docIds.length} docs)`);
      for (const h of hashes || []) {
        console.log(`    doc ${h.id} hash=${(h.file_hash || "—").slice(0, 16)}... type=${h.classified_type} status=${h.status} user=${h.user_id}`);
      }
    }
  }

  hr("STEP 4 — feature_flag_rules current values (gates on corroboration eval)");

  const flagsOfInterest = [
    "consumer_read_filter_v1",
    "pattern1_corroboration_threshold",
    "canonical_promotion_event_v1",
    "dispute_feedback_loop",
    "phone_otp_enforcement_v1",
    "turnstile_enforcement_v1",
  ];
  const { data: flagRules } = await sb
    .from("feature_flag_rules")
    .select("flag_key, target_type, target_value, enabled, config, updated_at")
    .in("flag_key", flagsOfInterest)
    .order("flag_key");
  console.log(JSON.stringify(flagRules, null, 2));

  hr("STEP 5 — evaluate_pattern1_corroboration probe (if any canonical_id available)");

  // Pick the first canonical_id (likely Andrew's plan); call the SQL function for one
  // representative plan-identity field to see what distinct_user_count it reports.
  const probeCanonicalId = Array.from(canonicalIds)[0];
  if (probeCanonicalId) {
    const { data: probe, error: probeErr } = await sb.rpc("evaluate_pattern1_corroboration", {
      p_canonical_plan_id: probeCanonicalId,
      p_service_slug: null,
      p_field_name: "in_deductible_individual",
    });
    if (probeErr) {
      console.log(`  evaluate_pattern1_corroboration RPC error: ${probeErr.message}`);
    } else {
      console.log(`  evaluate_pattern1_corroboration(canonical=${probeCanonicalId}, slug=null, field=in_deductible_individual):`);
      console.log(JSON.stringify(probe, null, 2));
    }
  } else {
    console.log("  (no canonical_id to probe)");
  }

  hr("DONE");
}

main().catch((e) => {
  console.error("Investigation script failed:", e);
  process.exit(1);
});
