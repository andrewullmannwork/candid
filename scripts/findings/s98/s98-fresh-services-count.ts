import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "../.env.local"), override: true });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
(async () => {
  const planId = "df5688ec-2eda-4c4e-b3a5-e9d31c2c5fb9";
  const docId = "5bf1cae2-c821-4639-ab22-a2a59ed8da8b";

  // Try minimal column set first to isolate any column-existence issue
  const { data: simpleRows, error: simpleErr } = await sb
    .from("plan_covered_services")
    .select("id,service_slug,copay,coinsurance,is_covered,source,confidence")
    .eq("insurance_plan_id", planId)
    .limit(50);
  console.log(`Simple-cols query: rows=${simpleRows?.length ?? 0} err=${simpleErr?.message ?? "<none>"}`);
  if (simpleRows && simpleRows.length > 0) {
    console.log(`First service: ${JSON.stringify(simpleRows[0])}`);
    const srcBreakdown: Record<string, number> = {};
    for (const s of simpleRows) srcBreakdown[(s as Record<string, unknown>).source as string ?? "<null>"] = (srcBreakdown[(s as Record<string, unknown>).source as string ?? "<null>"] ?? 0) + 1;
    console.log(`source breakdown: ${JSON.stringify(srcBreakdown)}`);
    console.log(`First 12 slugs (sorted):`);
    const sorted = [...simpleRows].sort((a, b) => ((a as Record<string, unknown>).service_slug as string).localeCompare((b as Record<string, unknown>).service_slug as string));
    for (const s of sorted.slice(0, 15)) {
      const r = s as Record<string, unknown>;
      console.log(`  ${r.service_slug} | copay=${r.copay} | coinsurance=${r.coinsurance} | covered=${r.is_covered} | src=${r.source} | conf=${r.confidence}`);
    }
  }

  // Now check field_provenance column existence
  const { data: fpRows, error: fpErr } = await sb
    .from("plan_covered_services")
    .select("id,field_provenance")
    .eq("insurance_plan_id", planId)
    .limit(5);
  console.log(`\nfield_provenance column query: rows=${fpRows?.length ?? 0} err=${fpErr?.message ?? "<none>"}`);
  if (fpRows && fpRows.length > 0) {
    const r = fpRows[0] as Record<string, unknown>;
    console.log(`First fp keys: ${r.field_provenance ? Object.keys(r.field_provenance as Record<string, unknown>).join(", ") : "<null>"}`);
    if (r.field_provenance) {
      const fp = r.field_provenance as Record<string, Record<string, unknown>>;
      const firstKey = Object.keys(fp)[0];
      if (firstKey) console.log(`First fp entry (${firstKey}): ${JSON.stringify(fp[firstKey]).substring(0, 250)}`);
    }
  }

  // canonical_haiku_extractions
  const { count: cheC, error: cheErr } = await sb
    .from("canonical_haiku_extractions")
    .select("id", { count: "exact", head: true })
    .eq("source_document_id", docId);
  console.log(`\ncanonical_haiku_extractions for this doc: count=${cheC} err=${cheErr?.message ?? "<none>"}`);

  // doc-level recheck
  const { data: d } = await sb.from("documents").select("status,processing_step,processing_total_pages,processing_completed_pages,parse_quality_score,parse_quality_layout,parse_quality_failure_mode,parse_quality_signature,updated_at,created_at").eq("id", docId).single();
  console.log(`\nDoc state: status=${d?.status} step=${d?.processing_step ?? "<null>"} pages=${d?.processing_completed_pages}/${d?.processing_total_pages} score=${d?.parse_quality_score} layout=${d?.parse_quality_layout} failure_mode=${d?.parse_quality_failure_mode ?? "<null>"}`);
})();
