/**
 * Backfill service_slug on claim_line_items that have null slugs.
 *
 * Queries claim_line_items WHERE service_slug IS NULL AND description IS NOT NULL
 * and resolves them through the LIVE service resolver (service-resolver.ts:
 * catalog + learned cache + one batched Haiku call) — the same path uploads use.
 * Previously this script used the legacy hardcoded-list mapper, which could never
 * emit a newly-added catalog slug; swapped per plans/unmapped_line_items_admin_fix.md
 * (Scope B) so "add the service to the catalog, then run the backfill" is true.
 *
 * Usage: npx tsx scripts/backfill-service-slugs.ts [--dry-run] [--limit N]
 *
 * Run after:
 *   - Adding new services to service_catalog
 *   - Admin-assigning unmapped groups (/admin/pipeline#unmapped) — cached codes resolve free
 *   - Fixing the service resolver
 */

import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "../.env.local"), override: true });

import { createClient } from "@supabase/supabase-js";
import { resolveServices, type ResolveLineInput } from "../src/lib/claims/service-resolver";
import { inferBillingCodeType } from "../src/lib/claims/service-mapper";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BATCH_SIZE = 50; // resolver batches its Haiku call internally
const WRITE_CONFIDENCE_FLOOR = 0.7; // parity with the resolver's haiku_confidence_floor default

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

  console.log(`\nBackfill service_slug on claim_line_items (live resolver)`);
  console.log(`  Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`  Limit: ${limit} rows\n`);

  const { data: items, error } = await supabase
    .from("claim_line_items")
    .select("id, line_number, billing_code, billing_code_type, description")
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

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(items.length / BATCH_SIZE)} (${batch.length} items)...`);

    const inputs: ResolveLineInput[] = batch.map((item, idx) => ({
      lineNumber: idx + 1,
      description: item.description || "",
      billingCode: item.billing_code || null,
      billingCodeType:
        item.billing_code_type || (item.billing_code ? inferBillingCodeType(item.billing_code) : null),
    }));

    // userId "" = the spend-guard's documented admin-driven bypass (no per-user cap);
    // this script runs under operator control with an explicit --limit.
    const resolutions = await resolveServices(inputs, { supabase, userId: "" });

    for (let j = 0; j < batch.length; j++) {
      const item = batch[j];
      const res = resolutions.get(j + 1);

      if (res?.slug && res.confidence >= WRITE_CONFIDENCE_FLOOR) {
        if (dryRun) {
          console.log(`  [DRY] ${item.id.slice(0, 8)} → ${res.slug} (${Math.round(res.confidence * 100)}%, ${res.source}) | "${item.description?.slice(0, 50)}"`);
          mapped++;
        } else {
          const { error: updateErr } = await supabase
            .from("claim_line_items")
            .update({
              service_slug: res.slug,
              metadata: { serviceMapping: { slug: res.slug, confidence: res.confidence, source: "backfill_resolver" } },
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
        console.log(`  SKIP ${item.id.slice(0, 8)} — ${res?.slug ? `low confidence ${Math.round((res.confidence ?? 0) * 100)}%` : "no match"} | "${item.description?.slice(0, 50)}"`);
      }
    }
  }

  console.log(`\nDone. ${dryRun ? "Would have mapped" : "Mapped"}: ${mapped} | Skipped: ${items.length - mapped - failed} | Write failures: ${failed}`);
}

main().catch(console.error);
