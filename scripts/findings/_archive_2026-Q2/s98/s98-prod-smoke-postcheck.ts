/**
 * scripts/s98-prod-smoke-postcheck.ts — S98 PROD smoke after f5f08c1 + pdfjs_primary_v1 global ON.
 * Read-only.
 *
 * Finds Andrew's most recent doc upload, surfaces:
 *  (a) doc state + processing progress + duration
 *  (b) which OCR path ran (pdfjs vs DocAI) — derived from doc.metadata if recorded
 *  (c) services extracted + plan-identity completeness + cite-grade rate
 *  (d) parse_quality_score / parse_quality_signature / parse_quality_layout (S92 substrate)
 *  (e) canonical_haiku_extractions count (citation pipeline)
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "../.env.local"), override: true });
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const ANDREW_EMAIL = "andrew.david.ullmann@gmail.com";

async function main() {
  console.log("S98 PROD smoke post-check\n");

  // 1. Resolve Andrew's user_id
  const { data: users } = await sb
    .from("users")
    .select("id,email,email_verified,phone_verified")
    .eq("email", ANDREW_EMAIL)
    .limit(1);
  if (!users || users.length === 0) {
    console.error(`  ❌ Could not find user ${ANDREW_EMAIL}`);
    process.exit(2);
  }
  const userId = users[0].id as string;
  console.log(`User: ${ANDREW_EMAIL} (${userId.substring(0, 8)}) email_verified=${users[0].email_verified} phone_verified=${users[0].phone_verified}\n`);

  // 2. Find Andrew's most recent doc
  const { data: docs } = await sb
    .from("documents")
    .select(
      "id,doc_type,status,processing_step,file_hash,file_name,created_at,updated_at,processing_total_pages,processing_completed_pages,processing_error,retry_count,parse_quality_score,parse_quality_layout,parse_quality_failure_mode,parse_quality_signature,metadata",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(3);
  if (!docs || docs.length === 0) {
    console.error("  ❌ No documents for Andrew.");
    process.exit(2);
  }

  console.log("--- Most recent 3 docs ---");
  for (const d of docs) {
    const startedAt = new Date(d.created_at as string);
    const endedAt = new Date(d.updated_at as string);
    const elapsedSec = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);
    console.log(`  ${d.id.substring(0, 8)} — ${d.file_name ?? "<no-name>"}`);
    console.log(`    created=${d.created_at} | elapsed=${elapsedSec}s | type=${d.doc_type ?? "<null>"} | status=${d.status} | step=${d.processing_step ?? "<null>"} | retry=${d.retry_count ?? 0}`);
    console.log(`    pages: total=${d.processing_total_pages ?? "<null>"} completed=${d.processing_completed_pages ?? "<null>"} | hash=${(d.file_hash ?? "").substring(0, 12)}...`);
    if (d.parse_quality_score !== null && d.parse_quality_score !== undefined) {
      console.log(`    parse_quality: score=${d.parse_quality_score} layout=${d.parse_quality_layout ?? "<null>"} failure_mode=${d.parse_quality_failure_mode ?? "<null>"} signature=${d.parse_quality_signature ?? "<null>"}`);
    }
    if (d.processing_error) console.log(`    err: ${d.processing_error.substring(0, 200)}`);
    // OCR path signal from metadata (if recorded)
    if (d.metadata) {
      const md = d.metadata as Record<string, unknown>;
      const ocrPath = md.ocr_path ?? md.ocr_extraction_method ?? md.pdfjs ?? null;
      if (ocrPath) console.log(`    metadata.ocr signal: ${JSON.stringify(ocrPath)}`);
    }
  }

  const doc = docs[0];
  console.log(`\n=== Focus: most recent doc ${doc.id.substring(0, 8)} (${doc.file_name}) ===\n`);

  // 3. insurance_plans row created
  const { data: plans } = await sb
    .from("insurance_plans")
    .select(
      "id,insurer_name,plan_name,plan_type,plan_year,is_active,source_document_id,in_deductible_individual,in_deductible_family,in_oop_max_individual,in_oop_max_family,out_deductible_individual,out_oop_max_individual,canonical_plan_id,source,verification_status,field_provenance,created_at",
    )
    .eq("user_id", userId)
    .eq("source_document_id", doc.id)
    .order("created_at", { ascending: false })
    .limit(2);
  if (!plans || plans.length === 0) {
    console.log("  ⚠️  No insurance_plans row with this doc as source_doc_id yet.");
  } else {
    const p = plans[0];
    console.log("--- insurance_plans row ---");
    console.log(`  id=${p.id.substring(0, 8)} active=${p.is_active} canonical=${p.canonical_plan_id?.substring(0, 8) ?? "<null>"} source=${p.source ?? "<null>"} verification=${p.verification_status ?? "<null>"}`);
    console.log(`  ${p.insurer_name ?? "<null>"} | ${p.plan_name ?? "<null>"} | ${p.plan_type ?? "<null>"} ${p.plan_year ?? "<null>"}`);
    console.log(`  in_ded ind/fam: ${p.in_deductible_individual}/${p.in_deductible_family} | in_oop ind/fam: ${p.in_oop_max_individual}/${p.in_oop_max_family}`);
    console.log(`  out_ded ind: ${p.out_deductible_individual} | out_oop ind: ${p.out_oop_max_individual}`);

    // Plan-identity 12-field count
    const PLAN_IDENTITY_FIELDS = [
      "insurer_name",
      "plan_name",
      "plan_type",
      "plan_year",
      "in_deductible_individual",
      "in_deductible_family",
      "in_oop_max_individual",
      "in_oop_max_family",
      "out_deductible_individual",
      "out_deductible_family",
      "out_oop_max_individual",
      "out_oop_max_family",
    ];
    const filled = PLAN_IDENTITY_FIELDS.filter((f) => {
      const v = (p as Record<string, unknown>)[f];
      return v !== null && v !== undefined && v !== "";
    });
    console.log(`  plan-identity: ${filled.length}/12 populated`);

    // Cite-grade rate from field_provenance
    const fp = (p.field_provenance ?? {}) as Record<string, Record<string, unknown>>;
    let totalProv = 0;
    let citeGrade = 0;
    let verbatimAbsent = 0;
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
      }
    }
    console.log(`  field_provenance: ${totalProv} fields with provenance; cite-grade=${citeGrade}/${totalProv}; verbatim_absent=${verbatimAbsent}`);
  }

  // 4. plan_covered_services + cite-grade rate
  if (plans && plans.length > 0) {
    const planId = plans[0].id;
    const { data: services, count: svcCount } = await sb
      .from("plan_covered_services")
      .select("id,service_slug,copay,coinsurance,is_covered,source,field_provenance,confidence", { count: "exact" })
      .eq("insurance_plan_id", planId);
    console.log(`\n--- plan_covered_services (count: ${svcCount ?? 0}) ---`);
    if (services && services.length > 0) {
      let citeGradeSvc = 0;
      let nonNullProvenance = 0;
      let smartSkip = 0;
      let docExtraction = 0;
      for (const s of services) {
        if (s.source === "doc_extraction" || s.source === "doc_extraction_eoc") docExtraction += 1;
        if (s.source === "doc_extraction_smart_skip") smartSkip += 1;
        const fp = (s.field_provenance ?? {}) as Record<string, Record<string, unknown>>;
        for (const field of Object.keys(fp)) {
          const entry = fp[field];
          if (entry && typeof entry === "object") {
            nonNullProvenance += 1;
            const sev = entry.source_excerpt_verified as string | undefined;
            const ssv = entry.source_section_verified as boolean | undefined;
            const ssh = entry.source_section_hint as string | undefined;
            if (sev === "verified" && ssv === true && !(ssh ?? "").endsWith("_DO_NOT_EXTRACT")) {
              citeGradeSvc += 1;
            }
          }
        }
      }
      const citeRate = nonNullProvenance > 0 ? ((citeGradeSvc / nonNullProvenance) * 100).toFixed(1) : "n/a";
      console.log(`  source breakdown: doc_extraction=${docExtraction} smart_skip=${smartSkip} (total services=${services.length})`);
      console.log(`  cite-grade fields: ${citeGradeSvc}/${nonNullProvenance} (${citeRate}%)`);
      console.log(`  Sample slugs: ${services.slice(0, 8).map((s) => s.service_slug).join(", ")}${services.length > 8 ? ` ... (+${services.length - 8} more)` : ""}`);
    }
  }

  // 5. canonical_haiku_extractions for this doc — citation pipeline
  console.log("\n--- canonical_haiku_extractions ---");
  const { count: cheCount } = await sb
    .from("canonical_haiku_extractions")
    .select("id", { count: "exact", head: true })
    .eq("source_document_id", doc.id);
  console.log(`  count: ${cheCount ?? 0}`);
  if ((cheCount ?? 0) === 0) {
    console.log("  ⚠️  Zero rows — either parse still running, or extraction skipped writing to citations table.");
  }

  console.log("\nDone.");
}
main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
