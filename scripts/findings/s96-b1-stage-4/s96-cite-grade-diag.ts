import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "../.env.local"), override: true });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const DOC_ID = "058e4c02-2105-4108-9db0-21f7eff1caf2";
const COST_FIELDS = ["in_copay","in_coinsurance","in_cost_description","out_copay","out_coinsurance","out_cost_description"];

async function main() {
  const { data: doc } = await sb.from("documents").select("linked_insurance_plan_id").eq("id", DOC_ID).single();
  const planId = doc!.linked_insurance_plan_id;

  const { data: services } = await sb
    .from("plan_covered_services")
    .select("service_id, place_of_service, in_copay, in_coinsurance, in_cost_description, out_copay, out_coinsurance, out_cost_description, covered, exclusion_reason, source, sbc_excerpt, sbc_page, field_provenance, notes")
    .eq("insurance_plan_id", planId);

  const ids = (services ?? []).map((s:any) => s.service_id).filter(Boolean);
  const { data: catalog } = await sb.from("service_catalog").select("id, slug, name").in("id", ids);
  const slugMap = new Map((catalog ?? []).map((c:any) => [c.id, `${c.slug} (${c.name})`]));

  const uncited: any[] = [];
  (services ?? []).forEach((s:any) => {
    const fp = s.field_provenance ?? {};
    const hasCostCite = COST_FIELDS.some(k => {
      const m = fp[k];
      return m && typeof m === "object" && m.source_excerpt_verified !== undefined;
    });
    if (!hasCostCite) {
      uncited.push({
        slug: slugMap.get(s.service_id) ?? "(no slug)",
        pos: s.place_of_service,
        covered: s.covered,
        exclusion: s.exclusion_reason,
        source: s.source,
        sbc_excerpt: (s.sbc_excerpt ?? "").slice(0,140),
        sbc_page: s.sbc_page,
        notes: (s.notes ?? "").slice(0, 100),
        in_copay: s.in_copay,
        in_coinsurance: s.in_coinsurance,
        in_cost_description: s.in_cost_description,
        out_copay: s.out_copay,
        out_coinsurance: s.out_coinsurance,
        out_cost_description: s.out_cost_description,
        fpKeys: Object.keys(fp),
      });
    }
  });
  console.log(`=== ${uncited.length} rows with ZERO cost-field Pattern P-8 metadata ===\n`);
  uncited.forEach((u, i) => {
    console.log(`[${i+1}] slug=${u.slug}`);
    console.log(`    place_of_service=${u.pos} covered=${u.covered} exclusion=${u.exclusion}`);
    console.log(`    source=${u.source}`);
    console.log(`    in_copay=${u.in_copay} in_coins=${u.in_coinsurance} in_desc="${u.in_cost_description ?? ""}"`);
    console.log(`    out_copay=${u.out_copay} out_coins=${u.out_coinsurance} out_desc="${u.out_cost_description ?? ""}"`);
    console.log(`    sbc_page=${u.sbc_page} sbc_excerpt="${u.sbc_excerpt}"`);
    console.log(`    notes="${u.notes}"`);
    console.log(`    field_provenance keys: [${u.fpKeys.join(", ")}]`);
    console.log();
  });
}

main().catch(e => { console.error(e); process.exit(1); });
