/**
 * Backfill service_slug on claim_line_items that have null slugs.
 *
 * Queries all claim_line_items WHERE service_slug IS NULL AND description IS NOT NULL,
 * batches them through the Haiku service mapper, and updates the rows.
 *
 * Usage: npx tsx scripts/backfill-service-slugs.ts [--dry-run] [--limit N]
 *
 * Run after:
 *   - Adding new services to service_catalog
 *   - Fixing the service mapper
 *   - Initial deployment of T0.5
 */

import { createClient } from "@supabase/supabase-js";
import { mapLineItemsToServices, inferBillingCodeType } from "../src/lib/claims/service-mapper";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BATCH_SIZE = 20; // Line items per Haiku call

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 500;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment");
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  console.log(`\nBackfill service_slug on claim_line_items`);
  console.log(`  Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`  Limit: ${limit} rows\n`);

  // Fetch null-slug line items
  const { data: items, error } = await supabase
    .from("claim_line_items")
    .select("id, line_number, billing_code, description")
    .is("service_slug", null)
    .not("description", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("Query failed:", error);
    process.exit(1);
  }

  if (!items || items.length === 0) {
    console.log("No null-slug line items found. Nothing to backfill.");
    return;
  }

  console.log(`Found ${items.length} line items with null service_slug\n`);

  let mapped = 0;
  let failed = 0;

  // Process in batches
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(items.length / BATCH_SIZE)} (${batch.length} items)...`);

    const inputs = batch.map((item, idx) => ({
      lineNumber: idx + 1,
      description: item.description || "",
      billingCode: item.billing_code || undefined,
      billingCodeType: item.billing_code ? inferBillingCodeType(item.billing_code) : undefined,
    }));

    const mappings = await mapLineItemsToServices(inputs);
    const mappingMap = new Map(mappings.map((m) => [m.lineNumber, m]));

    for (let j = 0; j < batch.length; j++) {
      const item = batch[j];
      const mapping = mappingMap.get(j + 1);

      if (mapping && mapping.confidence >= 0.3) {
        if (dryRun) {
          console.log(`  [DRY] ${item.id.slice(0, 8)} → ${mapping.serviceSlug} (${Math.round(mapping.confidence * 100)}%) | "${item.description?.slice(0, 50)}"`);
        } else {
          const { error: updateErr } = await supabase
            .from("claim_line_items")
            .update({
              service_slug: mapping.serviceSlug,
              metadata: { serviceMapping: { slug: mapping.serviceSlug, confidence: mapping.confidence, source: "backfill" } },
            })
            .eq("id", item.id);

          if (updateErr) {
            console.error(`  FAIL ${item.id.slice(0, 8)}: ${updateErr.message}`);
            failed++;
          } else {
            mapped++;
          }
        }
      } else {
        console.log(`  SKIP ${item.id.slice(0, 8)} — no confident match | "${item.description?.slice(0, 50)}"`);
      }
    }
  }

  console.log(`\nDone. ${dryRun ? "Would have mapped" : "Mapped"}: ${mapped} | Skipped/failed: ${items.length - mapped}`);
}

main().catch(console.error);
