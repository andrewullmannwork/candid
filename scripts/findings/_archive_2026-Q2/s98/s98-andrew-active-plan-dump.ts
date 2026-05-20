import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "../../../.env.local"), override: true });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
(async () => {
  // Andrew user
  const { data: u } = await sb.from("users").select("id").eq("email", "andrew.david.ullmann@gmail.com").single();
  if (!u) { console.log("user not found"); return; }
  const userId = u.id as string;

  // Profile + active_insurance_plan_id
  const { data: profile } = await sb.from("profiles").select("active_insurance_plan_id, insurer, plan_type, state").eq("user_id", userId).single();
  console.log("Profile:", JSON.stringify(profile));

  if (!profile?.active_insurance_plan_id) { console.log("No active plan set on profile"); return; }
  const activePlanId = profile.active_insurance_plan_id as string;
  console.log(`\nActive plan: ${activePlanId}\n`);

  const { data: plan } = await sb.from("insurance_plans").select("id, insurer_name, plan_name, plan_year, is_active, canonical_plan_id, source, source_document_id").eq("id", activePlanId).single();
  console.log(`Plan row: ${JSON.stringify(plan)}\n`);

  // plan_covered_services on the active plan + group by slug
  const { data: pcs } = await sb
    .from("plan_covered_services")
    .select("id, place_of_service, in_copay, in_coinsurance, source, service_id, concept_id")
    .eq("insurance_plan_id", activePlanId);
  console.log(`active plan has ${pcs?.length ?? 0} plan_covered_services rows\n`);

  if (pcs && pcs.length > 0) {
    const serviceIds = [...new Set(pcs.map((r) => r.service_id).filter(Boolean))];
    const { data: catalog } = await sb.from("service_catalog").select("id, slug").in("id", serviceIds);
    const idToSlug = new Map(catalog?.map((c) => [c.id as string, c.slug as string]) ?? []);
    const bySlug: Record<string, { id: string; pos: string | null; service_id: string | null; concept_id: string | null; src: string | null }[]> = {};
    for (const r of pcs) {
      const slug = idToSlug.get(r.service_id as string) ?? `?service_id=${r.service_id}`;
      if (!bySlug[slug]) bySlug[slug] = [];
      bySlug[slug].push({ id: r.id as string, pos: r.place_of_service as string | null, service_id: r.service_id as string | null, concept_id: r.concept_id as string | null, src: r.source as string | null });
    }
    const dupes = Object.entries(bySlug).filter(([, rows]) => rows.length > 1);
    console.log(`Active plan: ${dupes.length} slugs with >1 row:\n`);
    for (const [slug, rows] of dupes.sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${slug} (${rows.length} rows):`);
      for (const r of rows) console.log(`    id=${r.id.substring(0, 8)} pos=${r.pos} src=${r.src} service_id=${r.service_id?.substring(0, 8)}`);
    }
  }

  // Also check if /plan API combines canonical_plan_services
  if (plan?.canonical_plan_id) {
    const { data: cps } = await sb.from("canonical_plan_services").select("id, service_slug, place_of_service, source").eq("canonical_plan_id", plan.canonical_plan_id);
    console.log(`\nCanonical plan has ${cps?.length ?? 0} canonical_plan_services rows`);
    if (cps && cps.length > 0) {
      const bySlug2: Record<string, { pos: string | null; src: string | null }[]> = {};
      for (const r of cps) {
        const slug = (r.service_slug as string) ?? "?";
        if (!bySlug2[slug]) bySlug2[slug] = [];
        bySlug2[slug].push({ pos: r.place_of_service as string | null, src: r.source as string | null });
      }
      const dupes2 = Object.entries(bySlug2).filter(([, rows]) => rows.length > 1);
      console.log(`Canonical: ${dupes2.length} slugs with >1 row`);
      for (const [slug, rows] of dupes2.sort((a, b) => b[1].length - a[1].length).slice(0, 20)) {
        console.log(`  ${slug} (${rows.length} rows): ${rows.map((r) => r.pos).join(", ")}`);
      }
    }
  }
})();
