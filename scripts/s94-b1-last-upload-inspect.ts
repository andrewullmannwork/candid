/**
 * scripts/s94-b1-last-upload-inspect.ts — quick read-only audit of Andrew's
 * most recent doc upload + any resulting claim/plan rows.
 *
 * Surfaces:
 *   - documents row (classification, doc_type, doc_type_override, processing_step)
 *   - insurance_plans row (if any landed)
 *   - plan_covered_services count
 *   - claims + claim_line_items + audit findings
 *   - total billed vs total recovery target
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

const EMAIL = "andrew.david.ullmann@gmail.com";

async function main() {
  const { data: user } = await sb.from("users").select("id, firebase_uid").eq("email", EMAIL).single();
  if (!user) throw new Error("user not found");

  const { data: docs } = await sb
    .from("documents")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(3);

  console.log("\n=== Last 3 documents ===");
  for (const d of docs ?? []) {
    console.log(`  ${d.id} | ${d.doc_type ?? "?"} | classification=${d.classified_type ?? "?"}@${d.classified_confidence ?? "?"} | status=${d.status} | step=${d.processing_step ?? "?"} | created ${d.created_at}`);
  }

  const latest = docs?.[0];
  if (!latest) return;

  console.log("\n=== Latest doc details ===");
  console.log(`  id: ${latest.id}`);
  console.log(`  doc_type: ${latest.doc_type}`);
  console.log(`  classified_type: ${latest.classified_type} @ ${latest.classified_confidence}`);
  console.log(`  doc_type_override_applied: ${latest.doc_type_override_applied ?? "(column n/a)"}`);
  console.log(`  status: ${latest.status} / step: ${latest.processing_step}`);
  console.log(`  page_count: ${latest.page_count}`);
  console.log(`  parse_quality_layout: ${latest.parse_quality_layout}`);
  console.log(`  parse_quality_score: ${latest.parse_quality_score}`);

  // Look for any plan rows
  const { data: plans } = await sb
    .from("insurance_plans")
    .select("id, plan_name, insurer_name, plan_type, plan_year, source_document_id, is_active, created_at")
    .or(`source_document_id.eq.${latest.id},user_id.eq.${user.id}`)
    .order("created_at", { ascending: false })
    .limit(5);
  console.log("\n=== Recent insurance_plans rows ===");
  for (const p of plans ?? []) {
    console.log(`  ${p.id} | ${p.plan_name ?? "?"} | ${p.insurer_name ?? "?"} | active=${p.is_active} | source_doc=${p.source_document_id?.slice(0, 8) ?? "?"}`);
  }

  // Plan_covered_services for any plans tied to this doc
  const planIds = (plans ?? []).filter((p) => p.source_document_id === latest.id).map((p) => p.id);
  if (planIds.length > 0) {
    const { count } = await sb
      .from("plan_covered_services")
      .select("*", { count: "exact", head: true })
      .in("insurance_plan_id", planIds);
    console.log(`\n=== plan_covered_services tied to this doc's plans: ${count} ===`);
  }

  // Claims + line items
  const { data: claims } = await sb
    .from("claims")
    .select("*")
    .eq("source_document_id", latest.id)
    .order("created_at", { ascending: false });
  console.log("\n=== Claims tied to this doc ===");
  for (const c of claims ?? []) {
    console.log(`  ${c.id} | service_date=${c.service_date} | total_billed=${c.total_billed} | total_patient_paid=${c.total_patient_paid} | total_insurance_adjusted=${c.total_insurance_adjusted}`);
  }

  if (claims && claims.length > 0) {
    for (const c of claims) {
      const { data: lines } = await sb
        .from("claim_line_items")
        .select("id, description, billing_code, billing_code_type, billed_amount, patient_responsibility, insurance_paid, patient_paid_amount, insurance_adjusted_amount, audit_status")
        .eq("claim_id", c.id);
      console.log(`\n  --- Line items for claim ${c.id} (${lines?.length ?? 0} rows) ---`);
      for (const li of lines ?? []) {
        console.log(`    ${li.billing_code ?? "?"}|${li.billing_code_type ?? "?"} | billed=$${li.billed_amount} | patientResp=$${li.patient_responsibility} | insPaid=$${li.insurance_paid} | patientPaid=$${li.patient_paid_amount ?? "?"} | insAdj=$${li.insurance_adjusted_amount ?? "?"} | "${(li.description ?? "").slice(0, 40)}"`);
      }

      // Audit findings
      const { data: findings } = await sb
        .from("audit_findings")
        .select("id, finding_type, recovery_target_amount, claim_line_item_id, dismissed_at")
        .eq("claim_id", c.id);
      if (findings && findings.length > 0) {
        console.log(`\n  --- Findings for claim ${c.id} (${findings.length} rows) ---`);
        let totalRec = 0;
        for (const f of findings) {
          console.log(`    ${f.finding_type} | recovery=$${f.recovery_target_amount} | line=${f.claim_line_item_id?.slice(0, 8) ?? "(claim-level)"} | dismissed=${!!f.dismissed_at}`);
          if (!f.dismissed_at) totalRec += Number(f.recovery_target_amount ?? 0);
        }
        console.log(`    -> Total active recovery: $${totalRec.toFixed(2)}`);
      }
    }
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
