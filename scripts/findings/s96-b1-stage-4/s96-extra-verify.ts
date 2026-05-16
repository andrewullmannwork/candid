import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "../.env.local"), override: true });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  // 1. Mig 105 with correct 'slug' column
  const { data: ltc, error: ltcErr } = await sb
    .from("service_catalog")
    .select("slug, category, canonical_for_concept, proposal_state")
    .eq("category", "long_term_care");
  console.log("=== Mig 105: long_term_care category rows ===");
  if (ltcErr) console.log("  ERROR:", ltcErr.message);
  else {
    console.log(`  ${ltc?.length ?? 0} rows in long_term_care category (expected 5 per mig 105)`);
    ltc?.forEach(r => console.log(`    ${r.slug} (canonical=${r.canonical_for_concept} proposal=${r.proposal_state})`));
  }

  // 2. Andrew's plan + user_id for active Cignas
  const { data: cignas } = await sb
    .from("insurance_plans")
    .select("id, plan_name, insurer_name, is_active, user_id")
    .ilike("insurer_name", "%cigna%");
  console.log("\n=== Cigna plans ===");
  cignas?.forEach(p => console.log(`  ${p.id} | user=${p.user_id.slice(0,8)} | ${p.plan_name} | active=${p.is_active}`));

  // 3. plan_covered_services count for Andrew's Cigna 38a33b4f
  const { count: pcsCount } = await sb
    .from("plan_covered_services")
    .select("*", { count: "exact", head: true })
    .eq("plan_id", "38a33b4f-25dd-4b5e-bf2c-605074bd6ca8");
  console.log(`\n=== plan_covered_services for Andrew's Cigna 38a33b4f ===\n  ${pcsCount} rows (S95 closeout said 0 expected — wiped by reset)`);

  // 4. feature_flag_rules — this is the rules table per mig 075 / s93 substrate
  console.log("\n=== feature_flag_rules ===");
  const { data: rules, error: rulesErr } = await sb
    .from("feature_flag_rules")
    .select("*")
    .in("flag_key", [
      "classifier_haiku_regex_fallback_v1",
      "unified_plan_doc_parser_v1",
      "parse_quality_tuning_v1",
      "sbc_parser_v1",
      "plan_doc_parser_v2",
      "doc_type_override_v1",
    ]);
  if (rulesErr) {
    console.log("  feature_flag_rules ERROR:", rulesErr.message);
  } else if (rules && rules.length) {
    rules.forEach((r: any) => {
      const cfg = r.config ?? {};
      const enabled = cfg.enabled ?? cfg.global_enabled ?? cfg.global ?? "?";
      console.log(`  ${r.flag_key}: enabled=${enabled} target_type=${r.target_type} config=${JSON.stringify(cfg).slice(0,80)}`);
    });
  } else {
    console.log("  no rows matched on flag_key");
    // dump schema
    const { data: sample } = await sb.from("feature_flag_rules").select("*").limit(2);
    if (sample?.[0]) console.log("  schema columns:", Object.keys(sample[0]).join(", "));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
