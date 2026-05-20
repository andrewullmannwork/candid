/**
 * Apply mig 112 (service_catalog_specialty_rx_tier5) to PROD via service-role.
 *
 * Idempotent: both inserts use ON CONFLICT DO NOTHING.
 * Pure DML; no schema changes; reversible via:
 *   DELETE FROM service_catalog WHERE slug='specialty_rx_tier5';
 *   DELETE FROM concepts WHERE vocabulary_id='CANDID' AND concept_code='specialty_rx_tier5';
 *
 * Usage: cd /Users/andrewullmann/Desktop/candid && npx tsx scripts/admin-cold-start/apply-mig-112.ts
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  console.log(`[mig 112] target: ${process.env.NEXT_PUBLIC_SUPABASE_URL}`);

  // ── Part 1: insert the concept (CANDID vocabulary) ─────────────────────
  const { data: concept, error: conceptErr } = await supabase
    .from("concepts")
    .upsert(
      {
        vocabulary_id: "CANDID",
        concept_code: "specialty_rx_tier5",
        concept_name: "Specialty Drugs (Tier 5)",
        concept_class: "service",
        domain: "service",
        is_active: true,
      },
      { onConflict: "vocabulary_id,concept_code", ignoreDuplicates: true },
    )
    .select("id, vocabulary_id, concept_code")
    .maybeSingle();
  if (conceptErr) {
    console.error("[mig 112] concept insert failed:", conceptErr.message);
    process.exit(1);
  }
  console.log(`[mig 112] concept upserted: ${JSON.stringify(concept) || "(no row returned — already existed)"}`);

  // Re-fetch concept by code (in case upsert returned null due to no-op)
  const { data: conceptLookup } = await supabase
    .from("concepts")
    .select("id")
    .eq("vocabulary_id", "CANDID")
    .eq("concept_code", "specialty_rx_tier5")
    .maybeSingle();
  if (!conceptLookup?.id) {
    console.error("[mig 112] failed to locate concept after upsert");
    process.exit(1);
  }
  const conceptId = (conceptLookup as { id: string }).id;
  console.log(`[mig 112] concept_id resolved: ${conceptId}`);

  // ── Part 2: insert the service_catalog row ─────────────────────────────
  const { data: catalogRow, error: catalogErr } = await supabase
    .from("service_catalog")
    .upsert(
      {
        slug: "specialty_rx_tier5",
        name: "Specialty Drugs (Tier 5)",
        category: "rx",
        concept_id: conceptId,
        canonical_for_concept: true,
        proposal_state: "canonical",
      },
      { onConflict: "slug", ignoreDuplicates: true },
    )
    .select("id, slug, concept_id, canonical_for_concept")
    .maybeSingle();
  if (catalogErr) {
    console.error("[mig 112] service_catalog insert failed:", catalogErr.message);
    process.exit(1);
  }
  console.log(`[mig 112] service_catalog upserted: ${JSON.stringify(catalogRow) || "(no row returned — already existed)"}`);

  // ── Verification ──────────────────────────────────────────────────────
  const { data: verifyConcept } = await supabase
    .from("concepts")
    .select("id, vocabulary_id, concept_code, concept_name")
    .eq("vocabulary_id", "CANDID")
    .eq("concept_code", "specialty_rx_tier5")
    .maybeSingle();
  const { data: verifyCatalog } = await supabase
    .from("service_catalog")
    .select("id, slug, category, canonical_for_concept, proposal_state")
    .eq("slug", "specialty_rx_tier5")
    .maybeSingle();

  console.log("");
  console.log("=== Post-apply verification ===");
  console.log("concept row:", JSON.stringify(verifyConcept, null, 2));
  console.log("service_catalog row:", JSON.stringify(verifyCatalog, null, 2));

  if (verifyConcept && verifyCatalog) {
    console.log("");
    console.log("✅ mig 112 applied successfully.");
  } else {
    console.log("");
    console.log("❌ mig 112 verification failed — rows not found.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[mig 112] fatal:", err);
  process.exit(1);
});
