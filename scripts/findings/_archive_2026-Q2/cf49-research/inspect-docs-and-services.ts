/**
 * Follow-ups for CF-49 stability investigation.
 *
 * 1. Why did (3a) find 0 documents matching file_hash? Inspect the docs by id
 *    (we have 21 source_document_ids from insurance_plans).
 * 2. What's in canonical_plan_services for canonical 0de67fb0…? new_services_found
 *    is consistently 35-53 per run — that means recordExtractionResult sees
 *    "extracted services not on canonical". Check whether canonical_plan_services
 *    is being populated at all.
 * 3. parse_audit_runs schema — does it exist? does it have any rows for these docs?
 * 4. Compare services_extracted across runs — do all 18 runs extract the same
 *    service slugs, or does Haiku produce a different set each time?
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
  // ── 1. Re-fetch docs via known source_document_ids ─────────────────────────
  const sourceDocIds = [
    "969f9bc8", "c8b72849", "59c06e4e", "c34d7159", "cf803ac2",
    "7f7df97b", "1f5e0bf9", "14c001bb", "713e77d7", "ecc5b383",
    "78d2c4f3", "e6137282", "bca5f4b6", "de928af7", "ffcfd145",
    "8d73e455", "16056c00", "2804d2e2", "f32b864b", "a9dba05a",
    "3517465b",
  ];

  header("(A) documents schema probe + lookup by id-prefix");
  // Schema probe
  const { data: schemaProbe } = await supabase.from("documents").select("*").limit(1);
  if (schemaProbe?.[0]) {
    const cols = Object.keys(schemaProbe[0]).sort();
    line(`documents columns: ${cols.join(", ")}`);
  }

  for (const prefix of sourceDocIds.slice(0, 5)) {
    const { data: docs } = await supabase
      .from("documents")
      .select("id, file_name, file_hash, doc_type, classified_type, status, processing_step, created_at, metadata")
      .like("id", `${prefix}%`)
      .limit(1);
    if (docs?.[0]) {
      const d = docs[0];
      line();
      line(`  id=${d.id}`);
      line(`  file_name=${d.file_name}`);
      line(`  file_hash=${d.file_hash}`);
      line(`  doc_type=${d.doc_type} classified=${d.classified_type}`);
      line(`  status=${d.status} step=${d.processing_step}`);
      line(`  created=${d.created_at}`);
      // Surface smart-skip / dedup / parse metadata
      const m = d.metadata as Record<string, unknown> | null;
      if (m && Object.keys(m).length > 0) {
        line(`  metadata keys: ${Object.keys(m).join(", ")}`);
      }
    }
  }

  // Now get ALL 21 docs by exact id (we have the prefixes from insurance_plans)
  header("(B) all 21 documents — file_hash + status distribution");
  const fullIds = sourceDocIds.map(p => p); // we'll fetch by prefix
  const allDocs: Record<string, unknown>[] = [];
  for (const prefix of fullIds) {
    const { data } = await supabase
      .from("documents")
      .select("id, file_name, file_hash, status, processing_step, doc_type, created_at")
      .like("id", `${prefix}%`)
      .limit(1);
    if (data?.[0]) allDocs.push(data[0]);
  }
  line(`Fetched ${allDocs.length}/21 docs.`);
  const hashCounts: Record<string, number> = {};
  const statusCounts: Record<string, number> = {};
  for (const d of allDocs as { id: string; file_hash: string | null; status: string; processing_step: string | null; doc_type: string }[]) {
    const h = d.file_hash ? d.file_hash.slice(0, 12) : "<null>";
    hashCounts[h] = (hashCounts[h] ?? 0) + 1;
    const s = `${d.status}/${d.processing_step ?? "null"}`;
    statusCounts[s] = (statusCounts[s] ?? 0) + 1;
  }
  line(`\nfile_hash distribution:`);
  for (const [h, n] of Object.entries(hashCounts)) line(`  ${h}…: ${n}`);
  line(`\nstatus/processing_step distribution:`);
  for (const [s, n] of Object.entries(statusCounts)) line(`  ${s}: ${n}`);

  line(`\nPer-doc detail (id, hash, doc_type, status):`);
  for (const d of allDocs as { id: string; file_hash: string | null; doc_type: string; status: string; processing_step: string | null }[]) {
    line(`  ${d.id.slice(0, 8)} hash=${d.file_hash?.slice(0, 12) ?? "<null>"}… doc_type=${d.doc_type} status=${d.status}/${d.processing_step ?? "null"}`);
  }

  // ── 2. canonical_plan_services — is the canonical service set ever updated? ─
  header("(C) canonical_plan_services for canonical 0de67fb0…");
  const { data: cps } = await supabase
    .from("canonical_plan_services")
    .select("service_slug, confidence, source")
    .eq("canonical_plan_id", CANONICAL_ID);
  line(`canonical_plan_services rows: ${cps?.length ?? 0}`);
  if (cps && cps.length > 0) {
    const sources: Record<string, number> = {};
    const slugs = new Set<string>();
    for (const r of cps) {
      sources[r.source ?? "<null>"] = (sources[r.source ?? "<null>"] ?? 0) + 1;
      if (r.service_slug) slugs.add(r.service_slug);
    }
    line(`  distinct service_slugs: ${slugs.size}`);
    line(`  source distribution: ${JSON.stringify(sources)}`);
    line(`  first 10 slugs: ${Array.from(slugs).slice(0, 10).join(", ")}`);
  } else {
    line(`  (empty — recordExtractionResult queries this table to compute newServicesFound)`);
  }

  // ── 3. parse_audit_runs ───────────────────────────────────────────────────
  header("(D) parse_audit_runs — schema + rows for these docs");
  // List tables to confirm name
  const { data: parProbe, error: parErr } = await supabase.from("parse_audit_runs").select("*").limit(1);
  if (parErr) {
    line(`Table does not exist or no access: ${parErr.message}`);
  } else if (parProbe?.[0]) {
    line(`Columns: ${Object.keys(parProbe[0]).sort().join(", ")}`);
    // Count rows for any of the doc IDs
    const fullDocIds = (allDocs as { id: string }[]).map(d => d.id);
    const { data: forUs, count } = await supabase
      .from("parse_audit_runs")
      .select("*", { count: "exact" })
      .in("document_id", fullDocIds)
      .order("created_at", { ascending: true });
    line(`Rows where document_id in our 21 docs: ${count ?? forUs?.length ?? 0}`);
    if (forUs && forUs.length > 0) {
      for (const r of forUs.slice(0, 5)) {
        line(`  ${JSON.stringify(r).slice(0, 300)}`);
      }
    }
  } else {
    line(`Table exists but is empty.`);
  }

  // ── 4. canonical_haiku_extractions services_count per run ─────────────────
  header("(E) per-haiku-run service-slug sets — variance check");
  const { data: cheRows } = await supabase
    .from("canonical_haiku_extractions")
    .select("haiku_run_id, service_slug, source_user_doc_hash, created_at")
    .eq("canonical_plan_id", CANONICAL_ID);
  // Group by run_id, accumulate distinct service_slugs
  const byRun = new Map<string, { slugs: Set<string>; hash: string | null; created: string }>();
  for (const r of cheRows ?? []) {
    const k = r.haiku_run_id;
    if (!byRun.has(k)) byRun.set(k, { slugs: new Set(), hash: r.source_user_doc_hash, created: r.created_at });
    if (r.service_slug) byRun.get(k)!.slugs.add(r.service_slug);
  }
  const runs = Array.from(byRun.entries()).sort((a, b) => a[1].created.localeCompare(b[1].created));
  line(`Total runs: ${runs.length}`);
  for (const [runId, info] of runs) {
    line(`  ${runId.slice(0, 30)} hash=${info.hash?.slice(0, 12)}… slugs=${info.slugs.size} created=${info.created}`);
  }
  // Pairwise overlap between first and last run
  if (runs.length >= 2) {
    const first = runs[0][1].slugs;
    const last = runs[runs.length - 1][1].slugs;
    const inter = Array.from(first).filter(s => last.has(s)).length;
    const onlyFirst = Array.from(first).filter(s => !last.has(s)).length;
    const onlyLast = Array.from(last).filter(s => !first.has(s)).length;
    line(`\n  first vs last run: intersection=${inter}, only-first=${onlyFirst}, only-last=${onlyLast}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
