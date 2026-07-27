/**
 * Path B PR #1 fixture — manually runnable per Block Ship Gate G4.
 *
 * Updated S245 (Group B / mig 187): realigned to the ALIGNED field names (in_copay/in_coinsurance/
 * in_deductible_applies/covered/prior_auth_required; the shipped RPC writes only aligned columns —
 * legacy copay/coinsurance/is_covered are vestigial) + adds the NEW typed-col arms (out_copay/
 * out_coinsurance/out_deductible_applies/requires_referral/visit_limit/annual_limit), the §14
 * p_provenance_meta Pattern-P8 carry (+ whitelist null-skip), and value==column for coinsurance (Tests 7-8).
 *
 * Asserts that apply_promotion_event (mig 187) correctly:
 *   1. Syncs typed columns alongside the field_provenance JSONB write
 *      on canonical_plans (plan-identity scalars) + canonical_plan_services
 *      (service fields).
 *   2. Normalizes coinsurance values to decimal [0, 1] regardless of
 *      whether the input JSONB stores decimal or integer-percent.
 *   3. Silent-skips typed-col sync when JSONB type doesn't match expected
 *      (preserves existing typed col value; field_provenance still updated).
 *   4. Preserves existing typed-col values for fields OTHER than the one
 *      being promoted (per-field UPDATE semantics).
 *   5. Idempotent across re-runs.
 *   6. Per-component isolation (S167 Thesaurus): the 4-col unique key
 *      (migs 147/148) keeps facility/professional and place_of_service
 *      variants as DISTINCT rows — promoting one component never clobbers
 *      another.
 *
 * Strategy: insert a synthetic canonical_plans row + canonical_plan_services
 * row with known-drifted typed cols. Call apply_promotion_event with
 * synthetic corroborated values. Assert typed cols + field_provenance match
 * post-call.
 *
 * Cleanup: deletes all synthetic rows at the end (try/finally) so re-runs
 * are clean.
 *
 * Run: cd <repo root> && set -a && source .env.local && set +a && \
 *      npx tsx scripts/path-b-pr1-fixture.ts
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env.");
  process.exit(1);
}

const sb: SupabaseClient = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  ✗ ${label}${detail ? `  (${detail})` : ""}`);
  }
}

function header(t: string) {
  console.log("\n" + "─".repeat(70) + "\n" + t + "\n" + "─".repeat(70));
}

interface Cleanup {
  canonicalIds: string[];
  insurerId?: string;
  promotionEventIds: string[];
  catalogSlugs: string[];
}

/**
 * Every synthetic slug the RPC legs promote through canonical_plan_services.
 * MUST be exhaustive: a missing slug now FK-403s the RPC insert (mig 213) and
 * the meta-carry asserts then fail against an empty entry — while the
 * "key SKIPPED" asserts pass vacuously (S289 DEV-apply lesson: exactly that
 * happened with fixture_pt/fixture_xray).
 */
const FIXTURE_SLUGS = [
  "fixture_office_visit",
  "fixture_specialist",
  "fixture_lab",
  "fixture_surgery",
  "fixture_inpatient",
  "fixture_mri",
  "fixture_pt",
  "fixture_xray",
] as const;

async function setup(cleanup: Cleanup): Promise<{ insurerId: string }> {
  // Resolve any existing insurer to point at; use the first one (no FK constraint
  // requires it to match a specific carrier — we're just satisfying the FK).
  const { data: insurer } = await sb.from("insurer_catalog").select("id").limit(1).single();
  if (!insurer?.id) {
    throw new Error("No insurer_catalog rows exist; cannot create synthetic canonical_plans row");
  }
  cleanup.insurerId = insurer.id;
  // mig 213 — cps.service_slug now FKs service_catalog(slug): seed the
  // synthetic slugs so the RPC's cps INSERTs pass; teardown removes them
  // after the cps rows (FK is NO ACTION, so order matters).
  for (const slug of FIXTURE_SLUGS) {
    const { error } = await sb.from("service_catalog").insert({
      slug,
      name: `Fixture — ${slug}`,
      category: "other",
    });
    if (error && !/duplicate key/i.test(error.message)) {
      throw new Error(`service_catalog fixture insert failed (${slug}): ${error.message}`);
    }
    if (!error) cleanup.catalogSlugs.push(slug);
  }
  return { insurerId: insurer.id };
}

async function insertSyntheticCanonical(
  cleanup: Cleanup,
  insurerId: string,
  drifted: Partial<{ deductible_individual: number; oop_max_individual: number; plan_name: string; metal_level: string }>,
): Promise<string> {
  const planName = drifted.plan_name ?? `Fixture Plan ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const { data, error } = await sb
    .from("canonical_plans")
    .insert({
      insurer_id: insurerId,
      plan_name: planName,
      plan_year: 2026,
      plan_type: "PPO",
      state: "CA",
      source_count: 1,
      confidence_score: 0.5,
      deductible_individual: drifted.deductible_individual ?? 999,
      oop_max_individual: drifted.oop_max_individual ?? 8888,
      metal_level: drifted.metal_level ?? "bronze",
      field_provenance: {},
    })
    .select("id")
    .single();
  if (error || !data?.id) throw new Error(`canonical_plans insert failed: ${error?.message}`);
  cleanup.canonicalIds.push(data.id);
  return data.id;
}

async function readCanonical(id: string) {
  const { data } = await sb
    .from("canonical_plans")
    .select(
      "id, deductible_individual, deductible_family, oop_max_individual, oop_max_family, plan_name, plan_year, plan_type, metal_level, field_provenance",
    )
    .eq("id", id)
    .single();
  return data;
}

async function readCps(canonicalId: string, serviceSlug: string, placeOfService = "any", component = "global") {
  const { data } = await sb
    .from("canonical_plan_services")
    .select("in_copay, in_coinsurance, in_deductible_applies, covered, prior_auth_required, out_copay, out_coinsurance, out_deductible_applies, requires_referral, visit_limit, annual_limit, place_of_service, component, field_provenance")
    .eq("canonical_plan_id", canonicalId)
    .eq("service_slug", serviceSlug)
    .eq("place_of_service", placeOfService)
    .eq("component", component)
    .single();
  return data;
}

async function applyPromotion(
  cleanup: Cleanup,
  canonicalId: string,
  serviceSlug: string | null,
  fieldName: string,
  value: unknown,
  placeOfService = "any",
  component = "global",
  provenanceMeta: Record<string, unknown> | null = null,
): Promise<string | null> {
  const { data, error } = await sb.rpc("apply_promotion_event", {
    p_canonical_plan_id: canonicalId,
    p_service_slug: serviceSlug,
    p_field_name: fieldName,
    p_corroborated_value: value,
    p_sources: [{ user_id_hash: `fixture-user-${Date.now()}`, recorded_at: new Date().toISOString() }],
    p_fire_source: "fixture",
    p_actor_user_id: null,
    p_force_event_type: "admin_override",
    p_place_of_service: placeOfService,
    p_component: component,
    p_provenance_meta: provenanceMeta,
  });
  if (error) {
    console.error(`  rpc error: ${error.message}`);
    return null;
  }
  if (typeof data === "string") cleanup.promotionEventIds.push(data);
  return typeof data === "string" ? data : null;
}

async function teardown(cleanup: Cleanup) {
  console.log("\n  cleanup…");
  if (cleanup.promotionEventIds.length > 0) {
    await sb.from("canonical_promotion_events").delete().in("id", cleanup.promotionEventIds);
  }
  if (cleanup.canonicalIds.length > 0) {
    // canonical_plan_services FKs to canonical_plans; delete those first
    await sb.from("canonical_plan_services").delete().in("canonical_plan_id", cleanup.canonicalIds);
    await sb.from("canonical_plans").delete().in("id", cleanup.canonicalIds);
  }
  if (cleanup.catalogSlugs.length > 0) {
    // After cps deletes — mig-213 FK (NO ACTION) blocks catalog deletion
    // while referenced.
    await sb.from("service_catalog").delete().in("slug", cleanup.catalogSlugs);
  }
  console.log(`  cleaned up ${cleanup.canonicalIds.length} canonical(s), ${cleanup.promotionEventIds.length} event(s), ${cleanup.catalogSlugs.length} catalog slug(s)`);
}

async function testCanonicalPlansTypedColSync(cleanup: Cleanup, insurerId: string) {
  header("Test 1: canonical_plans typed-col sync (8 plan-identity fields)");

  // Insert with KNOWN drifted typed cols (deductible 999; OOP 8888; metal bronze; plan_name 'OLD')
  const canId = await insertSyntheticCanonical(cleanup, insurerId, {
    deductible_individual: 999,
    oop_max_individual: 8888,
    plan_name: "OLD Plan Name",
    metal_level: "bronze",
  });

  // Promote in_deductible_individual to 1500 (NEW value)
  await applyPromotion(cleanup, canId, null, "in_deductible_individual", 1500);
  const c1 = await readCanonical(canId);
  assert(c1?.deductible_individual === 1500, "deductible_individual typed-col synced from JSONB 1500");
  assert(c1?.field_provenance?.in_deductible_individual?.value === 1500, "in_deductible_individual JSONB value=1500");
  assert(c1?.field_provenance?.in_deductible_individual?.confidence === 0.9, "in_deductible_individual JSONB confidence=0.9");
  assert(c1?.oop_max_individual === 8888, "oop_max_individual NOT touched (different field)");
  assert(c1?.plan_name === "OLD Plan Name", "plan_name NOT touched (different field)");

  // Promote in_oop_max_individual to 9000
  await applyPromotion(cleanup, canId, null, "in_oop_max_individual", 9000);
  const c2 = await readCanonical(canId);
  assert(c2?.oop_max_individual === 9000, "oop_max_individual typed-col synced");
  assert(c2?.deductible_individual === 1500, "deductible_individual preserved from prior promotion");

  // Promote plan_name to "NEW Plan Name"
  await applyPromotion(cleanup, canId, null, "plan_name", "NEW Plan Name");
  const c3 = await readCanonical(canId);
  assert(c3?.plan_name === "NEW Plan Name", "plan_name typed-col synced (string)");

  // Promote plan_year to 2027
  await applyPromotion(cleanup, canId, null, "plan_year", 2027);
  const c4 = await readCanonical(canId);
  assert(c4?.plan_year === 2027, "plan_year typed-col synced (int)");

  // Promote metal_level to "gold"
  await applyPromotion(cleanup, canId, null, "metal_level", "gold");
  const c5 = await readCanonical(canId);
  assert(c5?.metal_level === "gold", "metal_level typed-col synced (string; latent gap closed)");

  // Promote plan_type to "HMO"
  await applyPromotion(cleanup, canId, null, "plan_type", "HMO");
  const c6 = await readCanonical(canId);
  assert(c6?.plan_type === "HMO", "plan_type typed-col synced (string)");
}

async function testCpsTypedColSyncFirstPromotion(cleanup: Cleanup, insurerId: string) {
  header("Test 2: canonical_plan_services typed-col sync — first-promotion INSERT path (aligned names)");

  const canId = await insertSyntheticCanonical(cleanup, insurerId, {});
  const slug = "fixture_office_visit";

  // First promotion ever for this (canonical, service) — must INSERT the row
  await applyPromotion(cleanup, canId, slug, "in_copay", 25);
  const cps1 = await readCps(canId, slug);
  assert(cps1 !== null, "canonical_plan_services row created via INSERT path");
  const cps1Copay = cps1?.in_copay;
  assert(cps1Copay !== null && cps1Copay !== undefined && Number(cps1Copay) === 25, "in_copay typed-col=25 on INSERT", `actual: ${cps1Copay}`);
  assert(cps1?.in_coinsurance === null, "in_coinsurance NULL on INSERT (different field)");
  assert(cps1?.in_deductible_applies === null, "in_deductible_applies NULL on INSERT");
  assert(cps1?.field_provenance?.in_copay?.value === 25, "in_copay JSONB value=25");

  // Subsequent promotion: in_deductible_applies = true
  await applyPromotion(cleanup, canId, slug, "in_deductible_applies", true);
  const cps2 = await readCps(canId, slug);
  assert(cps2?.in_deductible_applies === true, "in_deductible_applies typed-col synced (boolean)");
  const cps2Copay = cps2?.in_copay;
  assert(cps2Copay !== null && cps2Copay !== undefined && Number(cps2Copay) === 25, "in_copay preserved from prior promotion");

  // Subsequent: covered = false
  await applyPromotion(cleanup, canId, slug, "covered", false);
  const cps3 = await readCps(canId, slug);
  assert(cps3?.covered === false, "covered typed-col synced (boolean false)");

  // Subsequent: prior_auth_required = true
  await applyPromotion(cleanup, canId, slug, "prior_auth_required", true);
  const cps4 = await readCps(canId, slug);
  assert(cps4?.prior_auth_required === true, "prior_auth_required typed-col synced (boolean true)");
}

async function testCoinsuranceNormalization(cleanup: Cleanup, insurerId: string) {
  header("Test 3: coinsurance normalization to decimal [0, 1] + value==column (§14 #3)");

  // Case A: integer-percent input (30) → typed-col 0.3 AND field_provenance.value 0.3 (single v_stored_value)
  const canIdA = await insertSyntheticCanonical(cleanup, insurerId, {});
  await applyPromotion(cleanup, canIdA, "fixture_specialist", "in_coinsurance", 30);
  const cpsA = await readCps(canIdA, "fixture_specialist");
  const cpsAVal = cpsA?.in_coinsurance;
  assert(
    cpsAVal !== null && cpsAVal !== undefined && Math.abs(Number(cpsAVal) - 0.3) < 0.001,
    "input=30 (integer-percent) → typed-col=0.3 (decimal; normalized)",
    `actual: ${cpsAVal}`,
  );
  const cpsAProvVal = cpsA?.field_provenance?.in_coinsurance?.value;
  assert(
    cpsAProvVal !== null && cpsAProvVal !== undefined && Math.abs(Number(cpsAProvVal) - 0.3) < 0.001,
    "input=30 → field_provenance.value=0.3 (value==column; §14 #3 single-source)",
    `actual: ${cpsAProvVal}`,
  );

  // Case B: decimal input (0.2) → typed-col 0.2 (no double-normalize); value==column
  const canIdB = await insertSyntheticCanonical(cleanup, insurerId, {});
  await applyPromotion(cleanup, canIdB, "fixture_specialist", "in_coinsurance", 0.2);
  const cpsB = await readCps(canIdB, "fixture_specialist");
  const cpsBVal = cpsB?.in_coinsurance;
  assert(
    cpsBVal !== null && cpsBVal !== undefined && Math.abs(Number(cpsBVal) - 0.2) < 0.001,
    "input=0.2 (decimal) → typed-col=0.2 (preserved; no double-normalize)",
    `actual: ${cpsBVal}`,
  );
  assert(
    Math.abs(Number(cpsB?.field_provenance?.in_coinsurance?.value) - 0.2) < 0.001,
    "input=0.2 → field_provenance.value=0.2 (value==column)",
    `actual: ${cpsB?.field_provenance?.in_coinsurance?.value}`,
  );

  // Case C: zero input → typed-col 0
  const canIdC = await insertSyntheticCanonical(cleanup, insurerId, {});
  await applyPromotion(cleanup, canIdC, "fixture_specialist", "in_coinsurance", 0);
  const cpsC = await readCps(canIdC, "fixture_specialist");
  const cpsCVal = cpsC?.in_coinsurance;
  assert(
    cpsCVal !== null && cpsCVal !== undefined && Number(cpsCVal) === 0,
    "input=0 → typed-col=0",
    `actual: ${cpsCVal}`,
  );

  // Case D: integer-percent above 100 (corrupted) → clamp to 1
  const canIdD = await insertSyntheticCanonical(cleanup, insurerId, {});
  await applyPromotion(cleanup, canIdD, "fixture_specialist", "in_coinsurance", 5000);
  const cpsD = await readCps(canIdD, "fixture_specialist");
  const cpsDVal = cpsD?.in_coinsurance;
  assert(
    cpsDVal !== null && cpsDVal !== undefined && Number(cpsDVal) === 1,
    "input=5000 (corrupted very-high integer-percent) → clamped to 1.0",
    `actual: ${cpsDVal}`,
  );
}

async function testTypeMismatchSilentSkip(cleanup: Cleanup, insurerId: string) {
  header("Test 4: type-mismatch silent skip (defense against future JSONB drift)");

  const canId = await insertSyntheticCanonical(cleanup, insurerId, {
    deductible_individual: 999,
  });

  // Pass string when number expected — typed col should stay at 999; JSONB still updates
  await applyPromotion(cleanup, canId, null, "in_deductible_individual", "not a number");
  const c1 = await readCanonical(canId);
  assert(c1?.deductible_individual === 999, "deductible_individual typed-col PRESERVED (type mismatch silent skip)");
  assert(c1?.field_provenance?.in_deductible_individual?.value === "not a number", "JSONB still got the string value (write doesn't fail)");

  // Pass number when string expected on plan_name — typed col should stay
  const canId2 = await insertSyntheticCanonical(cleanup, insurerId, { plan_name: "OLD" });
  await applyPromotion(cleanup, canId2, null, "plan_name", 12345);
  const c2 = await readCanonical(canId2);
  assert(c2?.plan_name === "OLD", "plan_name typed-col PRESERVED on type mismatch (number vs string)");
  assert(c2?.field_provenance?.plan_name?.value === 12345, "JSONB still got the number");

  // For canonical_plan_services: pass string when boolean expected on in_deductible_applies
  const canId3 = await insertSyntheticCanonical(cleanup, insurerId, {});
  await applyPromotion(cleanup, canId3, "fixture_lab", "in_deductible_applies", "maybe");
  const cps3 = await readCps(canId3, "fixture_lab");
  assert(cps3?.in_deductible_applies === null, "cps in_deductible_applies stays NULL on type mismatch (no boolean cast)");
  assert(cps3?.field_provenance?.in_deductible_applies?.value === "maybe", "JSONB got the string anyway");
}

async function testIdempotency(cleanup: Cleanup, insurerId: string) {
  header("Test 5: idempotency — re-promoting same value is a no-op");

  const canId = await insertSyntheticCanonical(cleanup, insurerId, {});

  // First promotion
  await applyPromotion(cleanup, canId, null, "in_deductible_individual", 2000);
  const c1 = await readCanonical(canId);

  // Re-promote SAME value (different fixture user_id_hash → counts as new corroborator)
  await applyPromotion(cleanup, canId, null, "in_deductible_individual", 2000);
  const c2 = await readCanonical(canId);

  assert(c2?.deductible_individual === 2000, "deductible_individual still 2000 after re-promote (idempotent)");
  assert(c2?.field_provenance?.in_deductible_individual?.value === 2000, "JSONB still 2000 after re-promote");
  // updated_at should advance (different write timestamp) — but value is unchanged
  assert(c1?.deductible_individual === c2?.deductible_individual, "no drift across idempotent re-promotion");
}

async function testPerComponentIsolation(cleanup: Cleanup, insurerId: string) {
  header("Test 6: per-component isolation (S167 4-col key — facility ≠ professional ≠ pos)");

  const canId = await insertSyntheticCanonical(cleanup, insurerId, {});
  const slug = "fixture_surgery";

  // Promote in_copay=100 at component=facility, then in_copay=250 at component=professional
  // (SAME canonical + slug + place_of_service, DIFFERENT component).
  await applyPromotion(cleanup, canId, slug, "in_copay", 100, "outpatient_facility", "facility");
  await applyPromotion(cleanup, canId, slug, "in_copay", 250, "outpatient_facility", "professional");

  const facility = await readCps(canId, slug, "outpatient_facility", "facility");
  const professional = await readCps(canId, slug, "outpatient_facility", "professional");
  assert(facility !== null && professional !== null, "both component rows exist (4-col key kept them distinct)");
  assert(Number(facility?.in_copay) === 100, "facility row in_copay=100 (NOT clobbered by the professional promote)", `actual: ${facility?.in_copay}`);
  assert(Number(professional?.in_copay) === 250, "professional row in_copay=250 (separate row)", `actual: ${professional?.in_copay}`);

  // Exactly 2 rows for (canonical, slug) so far — the component split is preserved, not collapsed.
  const { data: rows2 } = await sb
    .from("canonical_plan_services")
    .select("place_of_service, component")
    .eq("canonical_plan_id", canId)
    .eq("service_slug", slug);
  assert((rows2?.length ?? 0) === 2, "exactly 2 rows for (canonical, slug) — component split preserved", `actual: ${rows2?.length}`);

  // place_of_service ALSO distinguishes: same component, different pos → a 3rd distinct row.
  await applyPromotion(cleanup, canId, slug, "in_copay", 75, "virtual", "professional");
  const virtualProf = await readCps(canId, slug, "virtual", "professional");
  assert(Number(virtualProf?.in_copay) === 75, "virtual/professional is a 3rd distinct row (pos distinguishes too)", `actual: ${virtualProf?.in_copay}`);
  const ofProfAfter = await readCps(canId, slug, "outpatient_facility", "professional");
  assert(Number(ofProfAfter?.in_copay) === 250, "outpatient_facility/professional unchanged by the virtual promote (no cross-pos clobber)", `actual: ${ofProfAfter?.in_copay}`);
}

async function testNewCoverageArms(cleanup: Cleanup, insurerId: string) {
  header("Test 7: NEW mig-187 arms — out_*/requires_referral/visit_limit/annual_limit");

  const canId = await insertSyntheticCanonical(cleanup, insurerId, {});
  const slug = "fixture_inpatient";

  // out_copay (numeric) — INSERT path
  await applyPromotion(cleanup, canId, slug, "out_copay", 50);
  const c1 = await readCps(canId, slug);
  assert(c1 !== null && Number(c1?.out_copay) === 50, "out_copay typed-col=50", `actual: ${c1?.out_copay}`);

  // out_coinsurance (numeric, normalized) + value==column
  await applyPromotion(cleanup, canId, slug, "out_coinsurance", 40);
  const c2 = await readCps(canId, slug);
  assert(Math.abs(Number(c2?.out_coinsurance) - 0.4) < 0.001, "out_coinsurance typed-col=0.4 (normalized)", `actual: ${c2?.out_coinsurance}`);
  assert(Math.abs(Number(c2?.field_provenance?.out_coinsurance?.value) - 0.4) < 0.001, "out_coinsurance field_provenance.value=0.4 (value==column)", `actual: ${c2?.field_provenance?.out_coinsurance?.value}`);

  // out_deductible_applies (boolean)
  await applyPromotion(cleanup, canId, slug, "out_deductible_applies", true);
  const c3 = await readCps(canId, slug);
  assert(c3?.out_deductible_applies === true, "out_deductible_applies typed-col synced (boolean)");

  // requires_referral (boolean)
  await applyPromotion(cleanup, canId, slug, "requires_referral", true);
  const c4 = await readCps(canId, slug);
  assert(c4?.requires_referral === true, "requires_referral typed-col synced (boolean)");

  // visit_limit (integer)
  await applyPromotion(cleanup, canId, slug, "visit_limit", 20);
  const c5 = await readCps(canId, slug);
  assert(Number(c5?.visit_limit) === 20, "visit_limit typed-col synced (integer)", `actual: ${c5?.visit_limit}`);

  // annual_limit (integer; the NUMBER mapped from annual_limit_value)
  await applyPromotion(cleanup, canId, slug, "annual_limit", 12);
  const c6 = await readCps(canId, slug);
  assert(Number(c6?.annual_limit) === 12, "annual_limit typed-col synced (integer; lossless)", `actual: ${c6?.annual_limit}`);

  // No cross-field clobber: every prior arm value survives the field-by-field promotes.
  assert(
    Number(c6?.out_copay) === 50 &&
      Math.abs(Number(c6?.out_coinsurance) - 0.4) < 0.001 &&
      c6?.out_deductible_applies === true &&
      c6?.requires_referral === true &&
      Number(c6?.visit_limit) === 20,
    "all prior arm values preserved after annual_limit promote (no cross-field clobber)",
  );
}

async function testProvenanceMetaCarry(cleanup: Cleanup, insurerId: string) {
  header("Test 8: §14 p_provenance_meta — Pattern-P8 carry + whitelist null-skip");

  // Full P-8 block carries the verified excerpt + the 5 cite-grade keys + resolution_source.
  const canId = await insertSyntheticCanonical(cleanup, insurerId, {});
  const slug = "fixture_mri";
  const fullMeta = {
    source_excerpt: "Coinsurance 40% after deductible (out-of-network).",
    source_excerpt_verified: true,
    source_excerpt_extraction_method: "verbatim_substring",
    source_section_hint: "Outpatient services",
    source_section_verified: true,
    resolution_source: "plan_doc",
  };
  await applyPromotion(cleanup, canId, slug, "out_coinsurance", 40, "any", "global", fullMeta);
  const e1 = (await readCps(canId, slug))?.field_provenance?.out_coinsurance;
  assert(e1?.source_excerpt === fullMeta.source_excerpt, "full meta: source_excerpt carried into provenance");
  assert(e1?.source_excerpt_verified === true, "full meta: source_excerpt_verified carried");
  assert(e1?.source_excerpt_extraction_method === "verbatim_substring", "full meta: source_excerpt_extraction_method carried");
  assert(e1?.source_section_hint === "Outpatient services", "full meta: source_section_hint carried");
  assert(e1?.source_section_verified === true, "full meta: source_section_verified carried");
  assert(e1?.resolution_source === "plan_doc", "full meta: resolution_source carried");
  assert(Math.abs(Number(e1?.value) - 0.4) < 0.001, "full meta: value still normalized=0.4 alongside the carry");

  // Partial meta: null keys SKIPPED (whitelist + null-skip), non-null carried, value preserved.
  const canId2 = await insertSyntheticCanonical(cleanup, insurerId, {});
  const slug2 = "fixture_pt";
  const partialMeta = {
    source_excerpt: "Physical therapy: 20 visits/year.",
    source_excerpt_verified: null,
    source_section_hint: null,
    resolution_source: "plan_doc",
  };
  await applyPromotion(cleanup, canId2, slug2, "visit_limit", 20, "any", "global", partialMeta);
  const e2 = (await readCps(canId2, slug2))?.field_provenance?.visit_limit ?? {};
  assert(e2?.source_excerpt === "Physical therapy: 20 visits/year.", "partial meta: present source_excerpt carried");
  assert(e2?.resolution_source === "plan_doc", "partial meta: present resolution_source carried");
  assert(!("source_excerpt_verified" in e2), "partial meta: null source_excerpt_verified SKIPPED (not written)");
  assert(!("source_section_hint" in e2), "partial meta: null source_section_hint SKIPPED (not written)");

  // cite:false equivalent — no meta arg → no excerpt key (byte-identical legacy entry).
  const canId3 = await insertSyntheticCanonical(cleanup, insurerId, {});
  const slug3 = "fixture_xray";
  await applyPromotion(cleanup, canId3, slug3, "in_copay", 30);
  const e3 = (await readCps(canId3, slug3))?.field_provenance?.in_copay ?? {};
  assert(!("source_excerpt" in e3), "no meta → no source_excerpt key (cite:false byte-identical)");
}

async function main() {
  console.log("Path B PR #1 fixture — apply_promotion_event typed-col sync\n");

  const cleanup: Cleanup = { canonicalIds: [], promotionEventIds: [], catalogSlugs: [] };

  try {
    const { insurerId } = await setup(cleanup);

    await testCanonicalPlansTypedColSync(cleanup, insurerId);
    await testCpsTypedColSyncFirstPromotion(cleanup, insurerId);
    await testCoinsuranceNormalization(cleanup, insurerId);
    await testTypeMismatchSilentSkip(cleanup, insurerId);
    await testIdempotency(cleanup, insurerId);
    await testPerComponentIsolation(cleanup, insurerId);
    await testNewCoverageArms(cleanup, insurerId);
    await testProvenanceMetaCarry(cleanup, insurerId);
  } finally {
    await teardown(cleanup);
  }

  console.log("\n" + "═".repeat(70));
  console.log(`Result: ${pass} PASS, ${fail} FAIL out of ${pass + fail} assertions`);
  if (fail > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  } else {
    console.log("All assertions PASSED ✓");
  }
}

void main();
