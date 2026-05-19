/**
 * CF-49 Research — Inspect "stuck at 1" stability counter
 *
 * READ-ONLY queries against the canonical_document_stability +
 * canonical_plans + documents tables for the hash prefix `e8a5540d557b`
 * (bs-bronze-60-ppo-clean-sbc.pdf, ~16 uploads, stuck at identical_parse_count=1).
 */

import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const HASH_PREFIX = "e8a5540d557b";
const CANONICAL_PREFIX = "0de67fb0";

function line(s = "") { console.log(s); }
function header(s: string) { line(); line("=".repeat(80)); line(s); line("=".repeat(80)); }
function sub(s: string) { line(); line("── " + s + " " + "─".repeat(Math.max(2, 75 - s.length))); }

async function main() {
  // ── (1) canonical_document_stability — the "stuck at 1" row ────────────────
  header("(1) canonical_document_stability rows matching hash prefix");
  const { data: stabilityRows, error: stabErr } = await supabase
    .from("canonical_document_stability")
    .select("*")
    .like("file_hash", `${HASH_PREFIX}%`);

  if (stabErr) { console.error("stability query failed:", stabErr); process.exit(1); }

  line(`Rows found: ${stabilityRows?.length ?? 0}`);
  for (const r of stabilityRows ?? []) {
    line();
    line(`file_hash:               ${r.file_hash}`);
    line(`canonical_plan_id:       ${r.canonical_plan_id}`);
    line(`identical_parse_count:   ${r.identical_parse_count}`);
    line(`haiku_output_stable:     ${r.haiku_output_stable}`);
    line(`upload_count:            ${r.upload_count}`);
    line(`first_seen_at:           ${r.first_seen_at}`);
    line(`last_seen_at:            ${r.last_seen_at}`);
    line(`updated_at:              ${r.updated_at}`);
    line(`last_haiku_extracted_values: ${JSON.stringify(r.last_haiku_extracted_values)}`);
    line(`candidate_slots (len=${(r.candidate_slots ?? []).length}):`);
    for (const slot of r.candidate_slots ?? []) {
      line(`  - values: ${JSON.stringify(slot.values)}`);
      line(`    services_count=${slot.services_count} match_count=${slot.match_count}`);
      line(`    first=${slot.first_seen_at} last=${slot.last_seen_at}`);
    }
    line(`v2-legacy: candidate_values=${JSON.stringify(r.candidate_values)} candidate_match_count=${r.candidate_match_count}`);
    line(`v4 cols:  parse_weight_accumulated=${r.parse_weight_accumulated} smart_skip_count=${r.smart_skip_count} last_full_parse_at=${r.last_full_parse_at}`);
  }

  const canonicalId = stabilityRows?.[0]?.canonical_plan_id;
  const fullHash = stabilityRows?.[0]?.file_hash;

  if (!canonicalId) {
    line("\nNo stability row found — bailing.");
    process.exit(0);
  }

  // ── (2) canonical_plans — the matching canonical row ──────────────────────
  header(`(2) canonical_plans row for ${canonicalId}`);
  const { data: canonicalRows, error: canErr } = await supabase
    .from("canonical_plans")
    .select("*")
    .eq("id", canonicalId);

  if (canErr) { console.error("canonical_plans query failed:", canErr); process.exit(1); }

  for (const c of canonicalRows ?? []) {
    for (const k of Object.keys(c).sort()) {
      const v = c[k];
      const display = (v && typeof v === "object") ? JSON.stringify(v).slice(0, 200) : v;
      line(`${k.padEnd(36)} ${display}`);
    }
  }

  // ── (3) documents linking via insurance_plans.canonical_plan_id ────────────
  header(`(3) documents linking to canonical ${canonicalId.slice(0, 8)}…`);
  // Path: documents → insurance_plans (via linked_insurance_plan_id) → canonical_plan_id
  // Also direct: any documents with file_hash matching this hash.

  sub("(3a) documents by file_hash (this exact PDF, regardless of canonical link)");
  const { data: docsByHash } = await supabase
    .from("documents")
    .select("id, user_id, file_name, file_hash, doc_type, classified_type, status, processing_step, processing_error, linked_insurance_plan_id, created_at, updated_at, metadata")
    .eq("file_hash", fullHash)
    .order("created_at", { ascending: true });

  line(`Documents matching file_hash=${fullHash?.slice(0, 16)}…: ${docsByHash?.length ?? 0}`);
  let i = 0;
  for (const d of docsByHash ?? []) {
    i++;
    line(`  ${String(i).padStart(2)}. id=${d.id.slice(0, 8)} user=${d.user_id.slice(0, 8)} status=${d.status} step=${d.processing_step ?? "-"}`);
    line(`      file_name=${d.file_name}`);
    line(`      doc_type=${d.doc_type} classified=${d.classified_type}`);
    line(`      linked_insurance_plan_id=${d.linked_insurance_plan_id ?? "null"}`);
    line(`      created=${d.created_at} updated=${d.updated_at}`);
    if (d.processing_error) line(`      error=${d.processing_error}`);
    const m = d.metadata as Record<string, unknown> | null;
    if (m && Object.keys(m).length > 0) {
      const keys = Object.keys(m);
      line(`      metadata keys (${keys.length}): ${keys.slice(0, 12).join(", ")}${keys.length > 12 ? "…" : ""}`);
      // Surface smart-skip / dedup-related metadata fields
      for (const k of keys) {
        if (/skip|dedup|canonical|haiku|stable|parse/i.test(k)) {
          line(`        ${k}: ${JSON.stringify(m[k]).slice(0, 200)}`);
        }
      }
    }
  }

  sub("(3b) documents linked via insurance_plans.canonical_plan_id");
  // First: find all insurance_plans rows that point to this canonical.
  const { data: ipLinks } = await supabase
    .from("insurance_plans")
    .select("id, user_id, source_document_id, created_at, updated_at")
    .eq("canonical_plan_id", canonicalId);

  line(`insurance_plans rows pointing at canonical=${canonicalId.slice(0, 8)}: ${ipLinks?.length ?? 0}`);
  for (const ip of ipLinks ?? []) {
    line(`  ip=${ip.id.slice(0, 8)} user=${ip.user_id.slice(0, 8)} source_doc=${ip.source_document_id?.slice(0, 8) ?? "null"} created=${ip.created_at}`);
  }

  // ── (4) parse_audit_runs ───────────────────────────────────────────────────
  header(`(4) parse_audit_runs for documents on this hash`);
  if ((docsByHash ?? []).length === 0) {
    line("No docs → no parse_audit_runs to check.");
  } else {
    // Inspect schema first
    sub("(4a) parse_audit_runs columns (one-row schema probe)");
    const { data: parProbe } = await supabase.from("parse_audit_runs").select("*").limit(1);
    if (parProbe && parProbe[0]) {
      const cols = Object.keys(parProbe[0]).sort();
      line(`Columns: ${cols.join(", ")}`);
    } else {
      line("No parse_audit_runs rows in table at all (or no permission).");
    }

    const docIds = (docsByHash ?? []).map(d => d.id);
    sub(`(4b) parse_audit_runs for the ${docIds.length} docs above`);
    const { data: parRows, error: parErr } = await supabase
      .from("parse_audit_runs")
      .select("*")
      .in("document_id", docIds)
      .order("created_at", { ascending: true });
    if (parErr) {
      line(`parse_audit_runs query error: ${parErr.message}`);
    } else {
      line(`parse_audit_runs rows: ${parRows?.length ?? 0}`);
      let j = 0;
      for (const r of parRows ?? []) {
        j++;
        const summary: string[] = [];
        for (const k of ["id", "document_id", "created_at", "parser_kind", "haiku_run_id", "outcome", "result", "smart_skip", "skip_reason", "haiku_tokens_input", "haiku_tokens_output", "cost_usd", "services_extracted"]) {
          if (k in r) {
            const v = r[k];
            const sv = (v && typeof v === "object") ? JSON.stringify(v).slice(0, 100) : v;
            summary.push(`${k}=${sv}`);
          }
        }
        line(`  ${String(j).padStart(2)}. ${summary.join(" | ")}`);
      }
    }
  }

  // ── (5) Cross-canonical comparison ─────────────────────────────────────────
  header("(5) Top-20 canonical_document_stability rows by identical_parse_count");
  const { data: topRows } = await supabase
    .from("canonical_document_stability")
    .select("canonical_plan_id, file_hash, identical_parse_count, haiku_output_stable, upload_count, first_seen_at, last_seen_at, candidate_slots")
    .order("identical_parse_count", { ascending: false })
    .limit(20);
  line(`Total rows: ${topRows?.length ?? 0}`);
  for (const r of topRows ?? []) {
    const slotsLen = (r.candidate_slots ?? []).length;
    line(`  canonical=${r.canonical_plan_id.slice(0, 8)} hash=${r.file_hash.slice(0, 12)}… ipc=${r.identical_parse_count} stable=${r.haiku_output_stable} uc=${r.upload_count} slots=${slotsLen} last_seen=${r.last_seen_at}`);
  }

  sub("(5b) histogram of identical_parse_count across ALL rows");
  const { data: allCounts } = await supabase
    .from("canonical_document_stability")
    .select("identical_parse_count");
  const hist: Record<number, number> = {};
  for (const r of allCounts ?? []) {
    const c = r.identical_parse_count;
    hist[c] = (hist[c] ?? 0) + 1;
  }
  line(`Total rows in canonical_document_stability: ${allCounts?.length ?? 0}`);
  for (const k of Object.keys(hist).sort((a, b) => Number(a) - Number(b))) {
    line(`  identical_parse_count=${k}: ${hist[Number(k)]} rows`);
  }

  // ── (6) canonical_haiku_extractions ────────────────────────────────────────
  header(`(6) canonical_haiku_extractions for canonical ${canonicalId.slice(0, 8)}…`);
  const { data: cheRows, error: cheErr } = await supabase
    .from("canonical_haiku_extractions")
    .select("id, user_id, document_id, haiku_run_id, parser_kind, field_name, service_slug, extracted_value, source_excerpt_verified, source_section_verified, source_user_doc_hash, created_at")
    .eq("canonical_plan_id", canonicalId)
    .order("created_at", { ascending: true });
  if (cheErr) {
    line(`canonical_haiku_extractions query error: ${cheErr.message}`);
  } else {
    line(`Total rows: ${cheRows?.length ?? 0}`);
    // Group by haiku_run_id to see how many runs there are
    const byRun = new Map<string, typeof cheRows>();
    for (const r of cheRows ?? []) {
      const k = r.haiku_run_id;
      if (!byRun.has(k)) byRun.set(k, []);
      byRun.get(k)!.push(r);
    }
    line(`Distinct haiku_run_id groups: ${byRun.size}`);
    let runIdx = 0;
    for (const [runId, rows] of byRun) {
      runIdx++;
      const first = rows[0];
      line(`  run #${runIdx}: ${runId.slice(0, 24)}… (${rows.length} field rows) user=${first.user_id.slice(0, 8)} doc=${first.document_id.slice(0, 8)} hash=${first.source_user_doc_hash?.slice(0, 12)}… at ${first.created_at} parser=${first.parser_kind}`);
      // Show the 4 plan-identity field values that govern stability counter
      for (const field of ["in_deductible_individual", "in_deductible_family", "in_oop_max_individual", "in_oop_max_family"]) {
        const row = rows.find(r => r.field_name === field && !r.service_slug);
        if (row) {
          line(`    ${field}: ${JSON.stringify(row.extracted_value)}  verified=${row.source_excerpt_verified} sect=${row.source_section_verified}`);
        }
      }
    }
  }

  // ── (7) document_extraction_log ────────────────────────────────────────────
  header(`(7) document_extraction_log for canonical ${canonicalId.slice(0, 8)}…`);
  const { data: delRows, error: delErr } = await supabase
    .from("document_extraction_log")
    .select("*")
    .eq("canonical_plan_id", canonicalId)
    .order("created_at", { ascending: true });
  if (delErr) {
    line(`document_extraction_log query error: ${delErr.message}`);
  } else {
    line(`Total rows: ${delRows?.length ?? 0}`);
    let k2 = 0;
    for (const r of delRows ?? []) {
      k2++;
      line(`  ${String(k2).padStart(2)}. id=${r.id.slice(0, 8)} doc=${r.document_id?.slice(0, 8)} user=${r.user_id?.slice(0, 8)} action=${r.action} services=${r.services_extracted} new=${r.new_services_found} skip_reason=${r.skip_reason ?? "-"} file_hash=${r.file_hash?.slice(0, 12) ?? "-"}… created=${r.created_at}`);
    }
  }

  // ── (8) processed-vs-other status counts for these docs ────────────────────
  header("(8) document status distribution for these docs");
  const statusCount: Record<string, number> = {};
  for (const d of docsByHash ?? []) {
    const s = `${d.status}/${d.processing_step ?? "null"}`;
    statusCount[s] = (statusCount[s] ?? 0) + 1;
  }
  for (const [s, n] of Object.entries(statusCount)) line(`  ${s}: ${n}`);
}

main().catch(e => { console.error(e); process.exit(1); });
