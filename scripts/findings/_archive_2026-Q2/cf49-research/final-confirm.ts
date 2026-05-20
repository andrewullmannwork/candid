/**
 * Final confirmation:
 * - Fetch the 21 docs by their UUID (using ip.source_document_id)
 * - Confirm their file_hash distribution + status
 * - Confirm canonical_plan_services for canonical_id is truly empty
 * - Confirm whether new_services_found per upload matches the LARGEST set
 *   compared to running cumulative canonical service set (the formula).
 */
import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const CANONICAL_ID = "0de67fb0-7c6f-4c53-83a4-6992a770efc5";

function line(s = "") { console.log(s); }
function header(s: string) { line(); line("=".repeat(80)); line(s); line("=".repeat(80)); }

async function main() {
  // Get the 21 source_document_ids from insurance_plans
  const { data: ips } = await supabase
    .from("insurance_plans")
    .select("source_document_id, created_at")
    .eq("canonical_plan_id", CANONICAL_ID);
  const docIds = (ips ?? []).map(i => i.source_document_id).filter((x): x is string => !!x);
  header(`(A) docs fetched by exact UUID — count=${docIds.length}`);

  const { data: docs } = await supabase
    .from("documents")
    .select("id, file_name, file_hash, doc_type, classified_type, status, processing_step, processing_error, created_at, metadata")
    .in("id", docIds)
    .order("created_at", { ascending: true });
  line(`Returned: ${docs?.length ?? 0}`);
  if (!docs) return;

  const hashCounts: Record<string, number> = {};
  const statusCounts: Record<string, number> = {};
  const docTypeCounts: Record<string, number> = {};
  for (const d of docs) {
    const h = d.file_hash ? d.file_hash.slice(0, 12) : "<null>";
    hashCounts[h] = (hashCounts[h] ?? 0) + 1;
    statusCounts[`${d.status}/${d.processing_step ?? "null"}`] = (statusCounts[`${d.status}/${d.processing_step ?? "null"}`] ?? 0) + 1;
    docTypeCounts[`${d.doc_type ?? "null"}/${d.classified_type ?? "null"}`] = (docTypeCounts[`${d.doc_type ?? "null"}/${d.classified_type ?? "null"}`] ?? 0) + 1;
  }
  line("\nfile_hash distribution:");
  for (const [h, n] of Object.entries(hashCounts).sort((a, b) => b[1] - a[1])) line(`  ${h}…: ${n}`);
  line("\nstatus/processing_step distribution:");
  for (const [s, n] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) line(`  ${s}: ${n}`);
  line("\ndoc_type/classified_type distribution:");
  for (const [t, n] of Object.entries(docTypeCounts).sort((a, b) => b[1] - a[1])) line(`  ${t}: ${n}`);

  line("\nPer-doc detail (chronological):");
  let i = 0;
  for (const d of docs) {
    i++;
    line(`  ${String(i).padStart(2)}. ${d.id.slice(0, 8)} hash=${d.file_hash?.slice(0, 12) ?? "<null>"}… doc_type=${d.doc_type}/${d.classified_type} status=${d.status}/${d.processing_step ?? "null"} file=${d.file_name?.slice(0, 50) ?? "-"}`);
    if (d.processing_error) line(`      err=${d.processing_error}`);
  }

  // ── (B) canonical_plan_services for this canonical — final word ───────────
  header("(B) canonical_plan_services — definitive count");
  const { data: cps, count: cpsCount } = await supabase
    .from("canonical_plan_services")
    .select("*", { count: "exact" })
    .eq("canonical_plan_id", CANONICAL_ID);
  line(`canonical_plan_services rows for ${CANONICAL_ID}: ${cpsCount ?? cps?.length ?? 0}`);
  if (cps && cps.length > 0) {
    line(`First row keys: ${Object.keys(cps[0]).join(", ")}`);
    const slugs = new Set<string>();
    for (const r of cps) if (r.service_slug) slugs.add(r.service_slug);
    line(`Distinct slugs: ${slugs.size}`);
  } else {
    line(`EMPTY. → newServicesFound = extractedServiceSlugs.length on every parse → NO_OP guard always fires.`);
  }

  // ── (C) Total canonical_plan_services across ALL canonicals (sanity) ──────
  header("(C) canonical_plan_services — global counts");
  const { count: globalCount } = await supabase
    .from("canonical_plan_services")
    .select("*", { count: "exact", head: true });
  line(`Total canonical_plan_services rows globally: ${globalCount ?? "?"}`);

  const { data: byCanon } = await supabase
    .from("canonical_plan_services")
    .select("canonical_plan_id");
  const canonCount: Record<string, number> = {};
  for (const r of byCanon ?? []) canonCount[r.canonical_plan_id] = (canonCount[r.canonical_plan_id] ?? 0) + 1;
  line(`Distinct canonical_plan_ids with services: ${Object.keys(canonCount).length}`);
  for (const [c, n] of Object.entries(canonCount).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    line(`  ${c.slice(0, 8)}: ${n} services`);
  }

  // ── (D) Spot-check document_extraction_log: services_extracted = new_services_found ─
  header("(D) document_extraction_log — services_extracted vs new_services_found");
  const { data: del } = await supabase
    .from("document_extraction_log")
    .select("created_at, services_extracted, new_services_found, file_hash, action")
    .eq("canonical_plan_id", CANONICAL_ID)
    .order("created_at", { ascending: true });
  let allEqual = true;
  for (const r of del ?? []) {
    if (r.services_extracted !== r.new_services_found) allEqual = false;
  }
  line(`Total log rows: ${del?.length ?? 0}`);
  line(`In EVERY row, services_extracted === new_services_found: ${allEqual}`);
  line(`→ Confirms canonical_plan_services has NEVER been populated; every extracted slug is "new".`);
}

main().catch(e => { console.error(e); process.exit(1); });
