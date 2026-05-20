/** scripts/s98-cigna-skeptical-check.ts — Skeptical re-eval: was services=0 smart-skip OR a real bug? */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "../.env.local"), override: true });
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const DOC_ID = "5bf1cae2-c821-4639-ab22-a2a59ed8da8b";
const FILE_HASH_PREFIX = "91f425a6";

async function main() {
  console.log("Skeptical re-evaluation: was services=0 SMART-SKIP or a real BUG?\n");

  // 1. document_extraction_log — does it record an action like "skipped_canonical_stable"?
  const { data: del } = await sb
    .from("document_extraction_log")
    .select("document_id,action,services_extracted,new_services_found,skip_reason,canonical_plan_id,created_at")
    .eq("document_id", DOC_ID);
  console.log(`--- document_extraction_log entries for this doc: ${del?.length ?? 0} ---`);
  for (const e of del ?? []) {
    console.log(`  action=${e.action} services=${e.services_extracted} new=${e.new_services_found} reason=${e.skip_reason ?? "<null>"} canonical=${e.canonical_plan_id ?? "<null>"} at=${e.created_at}`);
  }
  if (!del || del.length === 0) {
    console.log("  ⚠ Empty — extraction log not written for this doc.");
  }

  // 2. canonical_document_stability — any row for this file_hash?
  const { data: stab } = await sb
    .from("canonical_document_stability")
    .select("canonical_plan_id,file_hash,identical_parse_count,haiku_output_stable,upload_count,first_seen_at,last_seen_at,candidate_slots")
    .like("file_hash", `${FILE_HASH_PREFIX}%`);
  console.log(`\n--- canonical_document_stability for file_hash ${FILE_HASH_PREFIX}*: ${stab?.length ?? 0} rows ---`);
  for (const s of stab ?? []) {
    console.log(`  canonical=${s.canonical_plan_id?.substring(0, 8) ?? "<null>"} | hash=${s.file_hash.substring(0, 16)} | count=${s.identical_parse_count} stable=${s.haiku_output_stable} uploads=${s.upload_count}`);
    if (s.candidate_slots) console.log(`    candidate_slots: ${JSON.stringify(s.candidate_slots).substring(0, 200)}`);
  }
  if (!stab || stab.length === 0) {
    console.log("  ✓ No stability row → smart-skip Path A CANNOT fire (no canonical+hash match).");
  }

  // 3. Any other docs in DB with the same file_hash (this exact PDF uploaded before)?
  const { data: sameHash } = await sb
    .from("documents")
    .select("id,user_id,file_name,doc_type,status,processing_step,created_at,processing_total_pages,processing_completed_pages")
    .like("file_hash", `${FILE_HASH_PREFIX}%`)
    .order("created_at", { ascending: false });
  console.log(`\n--- Documents with file_hash ${FILE_HASH_PREFIX}*: ${sameHash?.length ?? 0} ---`);
  for (const d of sameHash ?? []) {
    console.log(`  ${d.created_at} | ${d.id.substring(0, 8)} | user=${(d.user_id as string).substring(0, 8)} | ${d.file_name} | status=${d.status} step=${d.processing_step ?? "<null>"} pages=${d.processing_completed_pages ?? "?"}/${d.processing_total_pages ?? "?"}`);
  }

  // 4. The insurance_plans row source field — definitive smart-skip indicator
  const { data: plans } = await sb
    .from("insurance_plans")
    .select("id,source,verification_status,canonical_plan_id,field_provenance,metadata,created_at,updated_at,is_active")
    .eq("source_document_id", DOC_ID);
  console.log(`\n--- insurance_plans source check ---`);
  for (const p of plans ?? []) {
    console.log(`  plan=${p.id.substring(0, 8)} source='${p.source}' verification='${p.verification_status}' canonical=${p.canonical_plan_id ?? "<null>"} is_active=${p.is_active}`);
    if (p.source === "doc_extraction_smart_skip") {
      console.log("  → SMART-SKIP DETECTED (source field confirms).");
    } else {
      console.log("  → NOT smart-skip (source field is fresh-parse).");
    }
    // Inspect field_provenance for any per-field source values
    const fp = (p.field_provenance ?? {}) as Record<string, Record<string, unknown>>;
    const sources = new Set<string>();
    for (const f of Object.keys(fp)) {
      const e = fp[f];
      if (e && typeof e === "object" && typeof e.source === "string") sources.add(e.source);
    }
    console.log(`  Per-field sources in field_provenance: ${[...sources].join(", ") || "<none>"}`);
    // Show first 2 provenance entries fully so we see source_excerpt etc.
    const keys = Object.keys(fp).slice(0, 2);
    for (const k of keys) {
      const e = fp[k];
      if (e) {
        const trimmed: Record<string, unknown> = {};
        for (const kk of Object.keys(e)) {
          const v = (e as Record<string, unknown>)[kk];
          trimmed[kk] = typeof v === "string" && v.length > 80 ? v.substring(0, 80) + "…" : v;
        }
        console.log(`  field=${k}: ${JSON.stringify(trimmed)}`);
      }
    }
  }

  // 5. Search Andrew's other Cigna plans — could services have landed on a different plan row?
  const { data: andrewPlans } = await sb
    .from("insurance_plans")
    .select("id,plan_name,plan_year,source,source_document_id,is_active,canonical_plan_id,created_at")
    .eq("user_id", "2ce55772-3ddd-465b-9d62-d1c3ade8d96c")  // we'll replace if wrong
    .ilike("plan_name", "%cigna%")
    .order("created_at", { ascending: false })
    .limit(8);
  console.log(`\n--- Andrew's plans matching insurer/name ILIKE %cigna%: ${andrewPlans?.length ?? 0} ---`);
  // Actually filter on user_id lookup first
  const { data: andrewUser } = await sb.from("users").select("id").eq("email", "andrew.david.ullmann@gmail.com").limit(1);
  if (andrewUser && andrewUser.length > 0) {
    const realUserId = andrewUser[0].id as string;
    const { data: andrewPlans2 } = await sb
      .from("insurance_plans")
      .select("id,plan_name,plan_year,source,source_document_id,is_active,canonical_plan_id,created_at")
      .eq("user_id", realUserId)
      .order("created_at", { ascending: false })
      .limit(10);
    console.log(`  Andrew's 10 most recent plans (any insurer):`);
    for (const p of andrewPlans2 ?? []) {
      console.log(`    ${p.id.substring(0, 8)} | ${p.created_at} | ${p.plan_name ?? "<null>"} ${p.plan_year ?? "<null>"} | source=${p.source ?? "<null>"} active=${p.is_active} doc=${p.source_document_id?.substring(0, 8) ?? "<null>"}`);
      // Check services on each
      const { count: svc } = await sb
        .from("plan_covered_services")
        .select("id", { count: "exact", head: true })
        .eq("insurance_plan_id", p.id);
      console.log(`      → plan_covered_services count: ${svc ?? 0}`);
    }
  }

  // 6. Final: was processing_step ever set non-null indicating sub-step progression?
  // We can't see history without an audit table — but the current state being step=null + status=processed
  // means the orchestrator marked it done. If services step errored, processing_error would be set.
  const { data: docFull } = await sb
    .from("documents")
    .select("processing_step,processing_error,status,updated_at,created_at,extracted_services,metadata")
    .eq("id", DOC_ID)
    .single();
  if (docFull) {
    console.log(`\n--- Final document state ---`);
    console.log(`  status=${docFull.status} step=${docFull.processing_step ?? "<null>"}`);
    console.log(`  error=${docFull.processing_error ?? "<null>"}`);
    console.log(`  extracted_services count: ${Array.isArray(docFull.extracted_services) ? (docFull.extracted_services as unknown[]).length : "<not-array>"}`);
    if (docFull.metadata) {
      const md = docFull.metadata as Record<string, unknown>;
      console.log(`  metadata keys: ${Object.keys(md).join(", ")}`);
      // Look for any hints about parse path / skip / ocr method
      for (const k of Object.keys(md)) {
        const v = md[k];
        const repr = typeof v === "string" ? v : JSON.stringify(v);
        console.log(`    ${k}: ${repr.substring(0, 120)}`);
      }
    }
  }
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
