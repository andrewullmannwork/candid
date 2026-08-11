/**
 * S308 — repair the DEV seed line whose slug never existed in service_catalog.
 *
 * Claim db733d7c's line carries service_slug 'physical_therapy' — a stale seed
 * token, absent from the catalog (the live therapy slug is pt_rehab). Repairing
 * it to pt_rehab would kill the Confirm-your-rate E2E leg (BlueSelect PRICES
 * pt_rehab), so it becomes 'acupuncture': a real catalog slug the plan covers
 * WITHOUT a rate (covered=true, copay/coins both null, no plan default) — the
 * chip fires legitimately, the answer lands, and the S223 covered-but-unpriced
 * backstop is exercised live. Description follows the slug.
 *
 * DEV-only. Dry-run by default:
 *   npx tsx scripts/s308-repair-seed-slug.ts          # show what would change
 *   npx tsx scripts/s308-repair-seed-slug.ts --apply
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
if (!url.includes("wdpkmgezhvlmaumhwqua")) {
  console.error(`REFUSING: ${new URL(url).host} is not DEV.`);
  process.exit(1);
}
const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const CLAIM = "db733d7c-ee70-4e9e-856a-5575f7a22dde";

async function main() {
  const { data: lines, error } = await sb
    .from("claim_line_items")
    .select("id, service_slug, description, billed_amount")
    .eq("claim_id", CLAIM);
  if (error) throw new Error(error.message);
  const target = (lines ?? []).find((l) => l.service_slug === "physical_therapy");
  if (!target) {
    console.log("No physical_therapy line on the claim — nothing to repair. Lines:");
    for (const l of lines ?? []) console.log(`  ${l.id} slug=${l.service_slug} "${l.description}"`);
    return;
  }
  // sanity: the replacement slug must exist live in the catalog
  const { data: cat, error: e2 } = await sb
    .from("service_catalog")
    .select("slug, merged_into_id")
    .eq("slug", "acupuncture")
    .maybeSingle();
  if (e2) throw new Error(e2.message);
  if (!cat || cat.merged_into_id != null) throw new Error("acupuncture is not a live catalog slug — aborting");

  console.log(`line ${target.id}: slug ${target.service_slug} → acupuncture · "${target.description}" → "Acupuncture (seed)" · $${target.billed_amount}`);
  if (!APPLY) {
    console.log("(dry run — pass --apply to write)");
    return;
  }
  const { error: e3 } = await sb
    .from("claim_line_items")
    .update({ service_slug: "acupuncture", description: "Acupuncture (seed)" })
    .eq("id", target.id);
  if (e3) throw new Error(e3.message);
  const { data: after } = await sb
    .from("claim_line_items")
    .select("service_slug, description")
    .eq("id", target.id)
    .single();
  console.log("APPLIED + verified:", JSON.stringify(after));
}
main().catch((e) => {
  console.error("REPAIR FAILED:", e.message);
  process.exit(1);
});
