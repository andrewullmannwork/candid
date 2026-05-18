/** scripts/s98-cigna-postcheck.ts — verify Andrew's just-uploaded Cigna plan doc in PROD. Read-only. */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "../.env.local"), override: true });
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const ANDREW_USER_ID = "2ce55772"; // prefix; we'll match via .like on text cast OR look up by file_name
const FILE_NAME = "current_cigna_plan.pdf";

async function main() {
  console.log(`S98 Cigna upload verify — most recent ${FILE_NAME} for Andrew\n`);

  const { data: docs } = await sb
    .from("documents")
    .select("*")
    .eq("file_name", FILE_NAME)
    .order("created_at", { ascending: false })
    .limit(1);
  if (!docs || docs.length === 0) {
    console.log("❌ Doc not found");
    process.exit(2);
  }
  const doc = docs[0];

  console.log("--- documents row ---");
  console.log(`  id:            ${doc.id}`);
  console.log(`  file_name:     ${doc.file_name}`);
  console.log(`  doc_type:      ${doc.doc_type}`);
  console.log(`  status:        ${doc.status}`);
  console.log(`  processing_step: ${doc.processing_step ?? "<null>"}`);
  console.log(`  pages:         ${doc.processing_completed_pages ?? "?"}/${doc.processing_total_pages ?? "?"}`);
  console.log(`  created_at:    ${doc.created_at}`);
  console.log(`  updated_at:    ${doc.updated_at}`);
  const startedAt = new Date(doc.created_at);
  const endedAt = new Date(doc.updated_at);
  console.log(`  duration:      ${Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)}s`);
  console.log(`  file_hash:     ${(doc.file_hash ?? "").substring(0, 16)}...`);
  console.log(`  retry_count:   ${doc.retry_count ?? 0}`);
  if (doc.processing_error) console.log(`  error:         ${doc.processing_error.substring(0, 200)}`);
  // Show columns relevant to parse_quality if present
  for (const k of Object.keys(doc).filter((c) => c.startsWith("parse_quality"))) {
    console.log(`  ${k}: ${doc[k] ?? "<null>"}`);
  }

  // 2. insurance_plans row created by this doc?
  const { data: plans } = await sb
    .from("insurance_plans")
    .select("*")
    .eq("source_document_id", doc.id)
    .limit(2);
  console.log(`\n--- insurance_plans rows from this doc: ${plans?.length ?? 0} ---`);
  if (plans && plans.length > 0) {
    const p = plans[0];
    console.log(`  plan_id:       ${p.id}`);
    console.log(`  insurer:       ${p.insurer_name ?? "<null>"}`);
    console.log(`  plan_name:     ${p.plan_name ?? "<null>"}`);
    console.log(`  plan_type:     ${p.plan_type ?? "<null>"} | year=${p.plan_year ?? "<null>"}`);
    console.log(`  is_active:     ${p.is_active}`);
    console.log(`  canonical_id:  ${p.canonical_plan_id ? String(p.canonical_plan_id).substring(0, 8) : "<null>"}`);
    console.log(`  source:        ${p.source ?? "<null>"} | verif: ${p.verification_status ?? "<null>"}`);
    console.log(`  in_ded ind/fam: ${p.in_deductible_individual}/${p.in_deductible_family}`);
    console.log(`  in_oop ind/fam: ${p.in_oop_max_individual}/${p.in_oop_max_family}`);
    console.log(`  out_ded ind/fam: ${p.out_deductible_individual}/${p.out_deductible_family}`);
    console.log(`  out_oop ind/fam: ${p.out_oop_max_individual}/${p.out_oop_max_family}`);

    // Plan-identity 12-field count
    const PLAN_IDENTITY_FIELDS = [
      "insurer_name","plan_name","plan_type","plan_year",
      "in_deductible_individual","in_deductible_family","in_oop_max_individual","in_oop_max_family",
      "out_deductible_individual","out_deductible_family","out_oop_max_individual","out_oop_max_family",
    ];
    const filled = PLAN_IDENTITY_FIELDS.filter((f) => {
      const v = (p as Record<string, unknown>)[f];
      return v !== null && v !== undefined && v !== "";
    });
    console.log(`  plan-identity: ${filled.length}/12 populated  (missing: ${PLAN_IDENTITY_FIELDS.filter((f) => !filled.includes(f)).join(", ") || "none"})`);

    // Cite-grade from field_provenance
    const fp = (p.field_provenance ?? {}) as Record<string, Record<string, unknown>>;
    let totalProv = 0;
    let citeGrade = 0;
    let verbatimAbsent = 0;
    let notFound = 0;
    for (const field of Object.keys(fp)) {
      const entry = fp[field];
      if (entry && typeof entry === "object") {
        totalProv += 1;
        const sev = entry.source_excerpt_verified as string | undefined;
        const ssv = entry.source_section_verified as boolean | undefined;
        const ssh = entry.source_section_hint as string | undefined;
        const isCite = sev === "verified" && ssv === true && !(ssh ?? "").endsWith("_DO_NOT_EXTRACT");
        if (isCite) citeGrade += 1;
        if (sev === "verbatim_absent") verbatimAbsent += 1;
        if (sev === "not_found") notFound += 1;
      }
    }
    const citeRate = totalProv > 0 ? ((citeGrade / totalProv) * 100).toFixed(1) : "n/a";
    console.log(`  field_provenance cite-grade: ${citeGrade}/${totalProv} (${citeRate}%) | verbatim_absent=${verbatimAbsent} | not_found=${notFound}`);

    // 3. plan_covered_services rows
    const { data: services, count: svcCount } = await sb
      .from("plan_covered_services")
      .select("service_slug,copay,coinsurance,is_covered,source,field_provenance,confidence", { count: "exact" })
      .eq("insurance_plan_id", p.id);
    console.log(`\n--- plan_covered_services for this plan: ${svcCount ?? 0} ---`);
    if (services && services.length > 0) {
      const srcBreakdown: Record<string, number> = {};
      let citeSvc = 0;
      let totalSvcProv = 0;
      for (const s of services) {
        srcBreakdown[s.source ?? "<null>"] = (srcBreakdown[s.source ?? "<null>"] ?? 0) + 1;
        const fp = (s.field_provenance ?? {}) as Record<string, Record<string, unknown>>;
        for (const field of Object.keys(fp)) {
          const entry = fp[field];
          if (entry && typeof entry === "object") {
            totalSvcProv += 1;
            const sev = entry.source_excerpt_verified as string | undefined;
            const ssv = entry.source_section_verified as boolean | undefined;
            const ssh = entry.source_section_hint as string | undefined;
            if (sev === "verified" && ssv === true && !(ssh ?? "").endsWith("_DO_NOT_EXTRACT")) citeSvc += 1;
          }
        }
      }
      const citeRate2 = totalSvcProv > 0 ? ((citeSvc / totalSvcProv) * 100).toFixed(1) : "n/a";
      console.log(`  source breakdown: ${JSON.stringify(srcBreakdown)}`);
      console.log(`  service-row cite-grade fields: ${citeSvc}/${totalSvcProv} (${citeRate2}%)`);
      console.log(`  Sample slugs (first 12):`);
      for (const s of services.slice(0, 12)) {
        console.log(`    ${s.service_slug} | copay=${s.copay} | coinsurance=${s.coinsurance} | covered=${s.is_covered} | src=${s.source} | conf=${s.confidence}`);
      }
      if (services.length > 12) console.log(`    ... (+${services.length - 12} more)`);
    }
  }

  // 4. canonical_haiku_extractions (citation pipeline)
  const { count: cheCount } = await sb
    .from("canonical_haiku_extractions")
    .select("id", { count: "exact", head: true })
    .eq("source_document_id", doc.id);
  console.log(`\n--- canonical_haiku_extractions for this doc: ${cheCount ?? 0} ---`);
  if ((cheCount ?? 0) > 0) {
    const { data: cheSample } = await sb
      .from("canonical_haiku_extractions")
      .select("extraction_type,service_slug,field_name,source_excerpt_extraction_method,source_excerpt_verified,source_section_hint,source_section_verified")
      .eq("source_document_id", doc.id)
      .limit(5);
    console.log(`  Sample rows:`);
    for (const c of cheSample ?? []) {
      const cite = c.source_excerpt_verified === "verified" && c.source_section_verified === true && !(c.source_section_hint ?? "").endsWith("_DO_NOT_EXTRACT");
      console.log(`    ${c.extraction_type} | ${c.service_slug ?? c.field_name ?? "?"} | method=${c.source_excerpt_extraction_method} | sev=${c.source_excerpt_verified} | ssv=${c.source_section_verified} | cite=${cite}`);
    }
  }

  // 5. parse_audit_runs entries for this doc — cost + cache + telemetry
  const { data: audits } = await sb
    .from("parse_audit_runs")
    .select("run_id,doc_id,parser,fixture_id,total_extracted,structurally_complete,cost_usd,duration_ms,warnings,started_at")
    .eq("doc_id", doc.id)
    .order("started_at", { ascending: false })
    .limit(3);
  console.log(`\n--- parse_audit_runs for this doc: ${audits?.length ?? 0} ---`);
  for (const a of audits ?? []) {
    console.log(`  ${a.started_at} | ${a.parser} | extracted=${a.total_extracted} complete=${a.structurally_complete} | cost=$${a.cost_usd} | dur=${a.duration_ms}ms`);
    if (a.warnings) console.log(`    warnings: ${JSON.stringify(a.warnings).substring(0, 200)}`);
  }
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
