import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "../../../.env.local"), override: true });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
(async () => {
  const planId = "df5688ec-2eda-4c4e-b3a5-e9d31c2c5fb9";
  // Find which columns exist on plan_covered_services
  const { data: sample, error } = await sb.from("plan_covered_services").select("*").eq("insurance_plan_id", planId).limit(1);
  if (error) console.log("err", error.message);
  if (sample && sample[0]) console.log("Columns:", Object.keys(sample[0]).join(", "));

  // Pull all rows + group by slug to confirm POS-variant duplicate hypothesis
  const { data: all, error: allErr } = await sb
    .from("plan_covered_services")
    .select("id, place_of_service, in_copay, in_coinsurance, covered, source, service_id")
    .eq("insurance_plan_id", planId);
  if (allErr) console.log("allErr:", allErr.message);
  console.log(`\nTotal rows: ${all?.length}\n`);

  // We need the slug — pull via service_id → service_catalog
  if (all && all.length > 0) {
    const serviceIds = [...new Set(all.map((r) => r.service_id))];
    const { data: catalog } = await sb
      .from("service_catalog")
      .select("id, slug")
      .in("id", serviceIds);
    const idToSlug = new Map<string, string>();
    for (const c of catalog ?? []) idToSlug.set(c.id as string, c.slug as string);

    const bySlug: Record<string, { pos: string | null; copay: number | null; coinsurance: number | null; covered: boolean | null; src: string | null }[]> = {};
    for (const r of all) {
      const slug = idToSlug.get(r.service_id as string) ?? "?";
      if (!bySlug[slug]) bySlug[slug] = [];
      bySlug[slug].push({ pos: r.place_of_service as string | null, copay: r.copay as number | null, coinsurance: r.coinsurance as number | null, covered: r.is_covered as boolean | null, src: r.source as string | null });
    }
    const dupes = Object.entries(bySlug).filter(([, rows]) => rows.length > 1);
    console.log(`Slugs with >1 row: ${dupes.length}\n`);
    for (const [slug, rows] of dupes.sort((a, b) => b[1].length - a[1].length)) {
      console.log(`${slug} (${rows.length} rows):`);
      for (const r of rows) console.log(`    pos=${r.pos ?? "<null>"} copay=${r.copay} coins=${r.coinsurance} covered=${r.covered} src=${r.src}`);
    }
  }
})();
