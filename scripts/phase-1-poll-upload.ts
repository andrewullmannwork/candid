/**
 * scripts/phase-1-poll-upload.ts — S90 Phase 1 monitoring helper.
 *
 * Read-only. Polls the most recent documents row for a given user_id and,
 * once status is terminal (processed | error), pulls downstream rows
 * (insurance_plans, canonical_plans, canonical_plan_services, claims if
 * the doc was a bill/EOB) so we can verify the end-to-end pipeline.
 *
 * Usage:
 *   npx tsx scripts/phase-1-poll-upload.ts <user_id> [since_minutes]
 *
 * since_minutes defaults to 5 — limits "most recent doc" to that window.
 */

import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(__dirname, "../.env.local"), override: true });

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const userId = process.argv[2];
if (!userId) {
  console.error("Usage: npx tsx scripts/phase-1-poll-upload.ts <user_id> [since_minutes]");
  process.exit(1);
}
const sinceMinutes = parseInt(process.argv[3] || "10", 10);

const POLL_INTERVAL_MS = 4000;
const MAX_POLL_SECONDS = 300; // 5 min

const sinceIso = new Date(Date.now() - sinceMinutes * 60 * 1000).toISOString();

interface DocRow {
  id: string;
  user_id: string;
  file_name: string | null;
  status: string;
  processing_step: string | null;
  processing_error: string | null;
  classified_type: string | null;
  classification_confidence: number | null;
  type_mismatch: boolean | null;
  file_hash: string | null;
  created_at: string;
}

function fmt(s: unknown) {
  if (s === null || s === undefined) return "—";
  if (typeof s === "string" && s.length > 80) return s.slice(0, 77) + "...";
  return String(s);
}

async function fetchMostRecentDoc(): Promise<DocRow | null> {
  const { data, error } = await sb
    .from("documents")
    .select(
      "id, user_id, file_name, status, processing_step, processing_error, classified_type, classification_confidence, type_mismatch, file_hash, created_at",
    )
    .eq("user_id", userId)
    .gt("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`documents query: ${error.message}`);
  return (data && data[0] as DocRow) || null;
}

async function pollUntilTerminal(): Promise<DocRow | null> {
  const start = Date.now();
  let lastStep = "";
  while ((Date.now() - start) / 1000 < MAX_POLL_SECONDS) {
    const doc = await fetchMostRecentDoc();
    if (!doc) {
      console.log(`  [${new Date().toISOString()}] no document yet (since=${sinceIso}); waiting…`);
    } else {
      const step = doc.processing_step || doc.status;
      if (step !== lastStep) {
        console.log(
          `  [${new Date().toISOString()}] doc=${doc.id.slice(0, 8)} status=${doc.status} step=${step} classified=${doc.classified_type} conf=${doc.classification_confidence}`,
        );
        lastStep = step;
      }
      if (doc.status === "processed" || doc.status === "error") return doc;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  console.log("  ⏱  polling timed out");
  return await fetchMostRecentDoc();
}

async function downstreamForPlanDoc(docId: string, userId: string) {
  console.log(`\n--- Downstream: insurance_plans + canonical_plans ---`);
  const { data: plans, error: planErr } = await sb
    .from("insurance_plans")
    .select("id, insurer_name, plan_name, plan_year, canonical_plan_id, is_active, source, source_document_id, is_aca_compliant, aca_compliance_basis, confidence, verification_status, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(5);
  if (planErr) console.log(`  ⚠ insurance_plans query: ${planErr.message}`);
  console.log(`  insurance_plans rows (recent 5):`);
  for (const p of plans || []) {
    const r = p as Record<string, unknown>;
    console.log(
      `    plan=${r.id} | ${r.insurer_name} / ${r.plan_name} / ${r.plan_year} | canonical=${r.canonical_plan_id ?? "—"} | source=${r.source} src_doc=${r.source_document_id ?? "—"} | active=${r.is_active} | conf=${r.confidence} verif=${r.verification_status} | aca=${r.is_aca_compliant ?? "—"} basis=${r.aca_compliance_basis ?? "—"}`,
    );
  }
  const matchingPlan = (plans || []).find((p) => (p as Record<string, unknown>).source_document_id === docId);
  if (matchingPlan) {
    const canonicalId = (matchingPlan as Record<string, unknown>).canonical_plan_id;
    if (canonicalId) {
      console.log(`\n  Canonical resolved: ${canonicalId}`);
      const { data: canonical, error: canonErr } = await sb
        .from("canonical_plans")
        .select("id, insurer_id, plan_name, plan_year, plan_type, metal_level, verification_count, extraction_count, haiku_output_stable, identical_parse_count, is_verified, confidence_score")
        .eq("id", canonicalId)
        .maybeSingle();
      if (canonErr) console.log(`  ⚠ canonical_plans query: ${canonErr.message}`);
      if (canonical) {
        const c = canonical as Record<string, unknown>;
        console.log(
          `    ${c.plan_name} / ${c.plan_year} / ${c.plan_type ?? "—"} / ${c.metal_level ?? "—"} | verif_count=${c.verification_count} extract_count=${c.extraction_count} identical=${c.identical_parse_count} stable=${c.haiku_output_stable} verified=${c.is_verified} conf=${c.confidence_score}`,
        );
      }
      const { count: cpsCount } = await sb
        .from("canonical_plan_services")
        .select("id", { count: "exact", head: true })
        .eq("canonical_plan_id", canonicalId);
      console.log(`    canonical_plan_services count: ${cpsCount}`);
    }
    // field_provenance on insurance_plans
    const fpInsurance = await sb
      .from("insurance_plans")
      .select("field_provenance")
      .eq("id", (matchingPlan as Record<string, unknown>).id as string)
      .maybeSingle();
    const fpKeys = fpInsurance.data?.field_provenance
      ? Object.keys(fpInsurance.data.field_provenance as object)
      : [];
    console.log(`\n  insurance_plans.field_provenance keys (${fpKeys.length}): ${fpKeys.slice(0, 8).join(", ")}${fpKeys.length > 8 ? "..." : ""}`);
  }
}

async function downstreamForBillOrEob(docId: string, userId: string) {
  console.log(`\n--- Downstream: claims + line_items + audit_findings ---`);
  const { data: claims } = await sb
    .from("claims")
    .select("id, claim_number, total_billed, total_patient_responsibility, total_insurance_paid, audit_status, source_document_id, created_at")
    .eq("user_id", userId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(5);
  console.log(`  claims rows (recent 5):`);
  for (const c of claims || []) {
    const r = c as Record<string, unknown>;
    console.log(
      `    claim=${r.id} | billed=$${r.total_billed} resp=$${r.total_patient_responsibility} ins_paid=$${r.total_insurance_paid} | audit=${r.audit_status} src_doc=${r.source_document_id ?? "—"}`,
    );
  }
  const matchingClaim = (claims || []).find((c) => (c as Record<string, unknown>).source_document_id === docId);
  if (matchingClaim) {
    const claimId = (matchingClaim as Record<string, unknown>).id as string;
    const { data: lines } = await sb
      .from("claim_line_items")
      .select("id, line_number, service_description, billing_code, billing_code_type, service_slug, service_slug_source, billed_amount, patient_responsibility, insurance_paid")
      .eq("claim_id", claimId)
      .order("line_number", { ascending: true });
    console.log(`\n  claim_line_items (${lines?.length || 0}):`);
    for (const l of lines || []) {
      const r = l as Record<string, unknown>;
      console.log(
        `    #${r.line_number} ${fmt(r.service_description)} | ${r.billing_code}/${r.billing_code_type} | slug=${r.service_slug ?? "—"} src=${r.service_slug_source ?? "—"} | billed=$${r.billed_amount} resp=$${r.patient_responsibility}`,
      );
    }
    const { data: findings } = await sb
      .from("audit_findings")
      .select("id, finding_type, severity, line_item_id, recovery_target_cents, message")
      .eq("claim_id", claimId);
    console.log(`\n  audit_findings (${findings?.length || 0}):`);
    for (const f of findings || []) {
      const r = f as Record<string, unknown>;
      console.log(
        `    type=${r.finding_type} severity=${r.severity} line=${r.line_item_id ?? "—"} recovery=${r.recovery_target_cents !== null ? `$${((r.recovery_target_cents as number) / 100).toFixed(2)}` : "—"}`,
      );
      console.log(`      ${fmt(r.message)}`);
    }
  }
}

async function main() {
  console.log(`Polling latest documents for user_id=${userId} since ${sinceIso} (window=${sinceMinutes}min)`);
  const finalDoc = await pollUntilTerminal();
  if (!finalDoc) {
    console.log(`\n❌ No document found within ${sinceMinutes}-minute window. Verify upload completed.`);
    process.exit(1);
  }
  console.log(`\n=== TERMINAL STATE ===`);
  console.log(`  doc_id          : ${finalDoc.id}`);
  console.log(`  file_name       : ${finalDoc.file_name}`);
  console.log(`  status          : ${finalDoc.status}`);
  console.log(`  processing_step : ${finalDoc.processing_step}`);
  console.log(`  processing_err  : ${fmt(finalDoc.processing_error)}`);
  console.log(`  classified_type : ${finalDoc.classified_type} (conf=${finalDoc.classification_confidence})`);
  console.log(`  type_mismatch   : ${finalDoc.type_mismatch}`);
  console.log(`  file_hash       : ${finalDoc.file_hash}`);
  console.log(`  created_at      : ${finalDoc.created_at}`);

  const ct = finalDoc.classified_type;
  if (ct === "sbc" || ct === "eoc" || ct === "plan_document") {
    await downstreamForPlanDoc(finalDoc.id, finalDoc.user_id);
  } else if (ct === "eob" || ct === "itemized_bill") {
    await downstreamForBillOrEob(finalDoc.id, finalDoc.user_id);
  } else {
    console.log(`\n  (no downstream check defined for classified_type=${ct})`);
  }
}

main().catch((e) => {
  console.error("Poll crashed:", e);
  process.exit(1);
});
