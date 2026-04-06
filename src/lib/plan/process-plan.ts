/**
 * Shared plan document processing logic.
 * Extracted from /api/documents/process so both the sync process route
 * and the chunked process-chunk route can use it.
 */

import { createServerClient } from "@/lib/supabase/server";
import { parseSBCText } from "@/lib/plan/sbc-parser";
import { parsePlanDocument } from "@/lib/plan/plan-doc-parser";

type SupabaseClient = ReturnType<typeof createServerClient>;

export interface ProcessPlanResult {
  success: boolean;
  planId?: string;
  servicesCreated?: number;
  planData?: {
    planName?: string | null;
    planType?: string | null;
    inDeductible?: number | null;
    outDeductible?: number | null;
    inOopMax?: number | null;
    outOopMax?: number | null;
    servicesExtracted: number;
  };
  parseWarnings?: string[];
  error?: string;
}

function inferServiceCategory(slug: string): string {
  if (/rx|drug|pharm|medication|prescription/.test(slug)) return "rx";
  if (/mental|psych|behavioral|substance|counseling/.test(slug)) return "mental_health";
  if (/therapy|rehab|pt_|ot_|speech|habilitation/.test(slug)) return "therapy";
  if (/hospital|inpatient|surgical|surgery/.test(slug)) return "hospital";
  if (/emergency|er_|urgent/.test(slug)) return "emergency";
  if (/imaging|mri|ct_|xray|ultrasound|radiol/.test(slug)) return "imaging";
  if (/lab|test|blood|pathol/.test(slug)) return "lab";
  if (/maternity|prenatal|delivery|pregnancy|birth/.test(slug)) return "maternity";
  if (/prevent|screen|immuniz|vaccine|wellness|physical/.test(slug)) return "preventive";
  if (/dme|equipment|prosthetic|diabetic/.test(slug)) return "dme";
  if (/visit|office|pcp|specialist|physician/.test(slug)) return "office_visit";
  if (/dental|vision|eye|hearing|glasses/.test(slug)) return "other";
  if (/hospice|home_health|skilled_nursing/.test(slug)) return "other";
  return "other";
}

/**
 * Process a plan document (SBC or full plan certificate).
 * Parses benefits, creates insurance_plans + plan_covered_services, links to user.
 */
export async function processPlanDocumentData(
  supabase: SupabaseClient,
  doc: { id: string; user_id: string; file_name: string },
  ocrText: string,
  documentId: string,
  classification: { classifiedType: string; confidence: number; mismatch: boolean }
): Promise<ProcessPlanResult> {
  try {
    const isFullPlanDoc = classification.classifiedType === "plan_document"
      || (classification.classifiedType !== "sbc" && ocrText.length > 50000);
    const parseResult = isFullPlanDoc
      ? parsePlanDocument(ocrText)
      : parseSBCText(ocrText, documentId);

    const planInsert = {
      ...parseResult.plan,
      user_id: doc.user_id,
      source: (isFullPlanDoc ? "plan_doc_upload" : "sbc_upload") as string,
      source_document_id: documentId,
      is_active: true,
      verification_status: "unverified" as const,
    };

    // Backfill nulls from profile (user may have manually entered deductible/OOP)
    const { data: userProfile } = await supabase
      .from("profiles")
      .select("deductible_individual, oop_max_individual, in_deductible_individual, in_oop_max_individual, out_deductible_individual, out_oop_max_individual")
      .eq("id", doc.user_id)
      .single();

    if (userProfile) {
      planInsert.in_deductible_individual ??= userProfile.in_deductible_individual ?? userProfile.deductible_individual;
      planInsert.in_oop_max_individual ??= userProfile.in_oop_max_individual ?? userProfile.oop_max_individual;
      planInsert.out_deductible_individual ??= userProfile.out_deductible_individual;
      planInsert.out_oop_max_individual ??= userProfile.out_oop_max_individual;
    }

    // Deactivate existing active plans
    await supabase
      .from("insurance_plans")
      .update({ is_active: false })
      .eq("user_id", doc.user_id)
      .eq("is_active", true);

    const { data: newPlan, error: planError } = await supabase
      .from("insurance_plans")
      .insert(planInsert)
      .select("id")
      .single();

    if (planError || !newPlan) {
      console.error("Failed to create insurance plan:", planError);
      await supabase.from("documents").update({ status: "error" }).eq("id", documentId);
      return {
        success: false,
        error: "Failed to save parsed plan data",
        parseWarnings: parseResult.parseWarnings,
      };
    }

    // Create plan_covered_services rows
    let servicesCreated = 0;
    if (parseResult.services.length > 0) {
      const slugs = [...new Set(parseResult.services.map((s) => s.serviceSlug))];
      const { data: serviceCatalog } = await supabase
        .from("service_catalog")
        .select("id, slug")
        .in("slug", slugs);

      const slugToId = new Map(serviceCatalog?.map((s) => [s.slug, s.id]) || []);

      // Auto-create missing service_catalog entries
      const knownSlugs = new Set(slugToId.keys());
      const newSlugs = [...new Set(
        parseResult.services
          .map((s) => s.serviceSlug)
          .filter((slug) => !knownSlugs.has(slug))
      )];

      if (newSlugs.length > 0) {
        const newEntries = newSlugs.map((slug) => ({
          slug,
          name: slug.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()),
          category: inferServiceCategory(slug),
          description: "",
          is_preventive_eligible: false,
        }));

        const { data: created } = await supabase
          .from("service_catalog")
          .upsert(newEntries, { onConflict: "slug" })
          .select("id, slug");

        for (const entry of created || []) {
          slugToId.set(entry.slug, entry.id);
        }
        console.log(`[process-plan] Auto-created ${created?.length || 0} service_catalog entries: ${newSlugs.slice(0, 5).join(", ")}${newSlugs.length > 5 ? "..." : ""}`);

        const otherSlugs = newEntries.filter(e => e.category === "other").map(e => e.slug);
        if (otherSlugs.length > 0) {
          try {
            const { notifyUncategorizedServices } = await import("@/lib/notifications");
            await notifyUncategorizedServices(otherSlugs);
          } catch (notifyErr) {
            console.warn("[process-plan] Failed to notify about uncategorized services:", notifyErr);
          }
        }
      }

      // Deduplicate: keep highest-confidence per (slug, place_of_service)
      const deduped = new Map<string, typeof parseResult.services[0]>();
      for (const s of parseResult.services) {
        if (!slugToId.has(s.serviceSlug)) continue;
        const key = `${s.serviceSlug}|${s.placeOfService || "any"}`;
        const existing = deduped.get(key);
        if (!existing || s.confidence > existing.confidence) {
          deduped.set(key, s);
        }
      }

      const serviceInserts = [...deduped.values()]
        .map((s) => ({
          insurance_plan_id: newPlan.id,
          service_id: slugToId.get(s.serviceSlug)!,
          place_of_service: s.placeOfService || "any",
          in_copay: s.inCopay,
          in_coinsurance: s.inCoinsurance,
          in_deductible_applies: s.inDeductibleApplies,
          in_copay_waiver_condition: s.inCopayWaiverCondition,
          in_cost_description: s.inCostDescription,
          out_copay: s.outCopay,
          out_coinsurance: s.outCoinsurance,
          out_deductible_applies: s.outDeductibleApplies,
          out_cost_description: s.outCostDescription,
          oon_paid_at_in_network: s.oonPaidAtInNetwork,
          annual_limit: s.annualLimit,
          annual_limit_value: s.annualLimitValue,
          prior_auth_required: s.priorAuthRequired,
          penalty_no_precert: s.penaltyNoPrecert,
          covered: s.covered,
          coverage_conditions: s.coverageConditions,
          supply_limit_days: s.supplyLimitDays,
          home_delivery_copay: s.homeDeliveryCopay,
          step_therapy_required: s.stepTherapyRequired,
          notes: s.notes,
          confidence: s.confidence,
          source: "sbc_parsed" as const,
        }));

      if (serviceInserts.length > 0) {
        const { error: svcError } = await supabase
          .from("plan_covered_services")
          .upsert(serviceInserts, { onConflict: "insurance_plan_id,service_id,place_of_service" });

        if (svcError) {
          console.error("Failed to insert covered services:", svcError);
        } else {
          servicesCreated = serviceInserts.length;
        }
      }
    }

    // Link document to insurance plan
    await supabase
      .from("documents")
      .update({
        status: "processed",
        linked_insurance_plan_id: newPlan.id,
        processing_step: null,
        processing_ocr_text: null,
      })
      .eq("id", documentId);

    // Set as active plan on profile
    await supabase
      .from("profiles")
      .update({ active_insurance_plan_id: newPlan.id })
      .eq("user_id", doc.user_id);

    return {
      success: true,
      planId: newPlan.id,
      servicesCreated,
      planData: {
        planName: parseResult.plan.plan_name,
        planType: parseResult.plan.plan_type,
        inDeductible: parseResult.plan.in_deductible_individual,
        outDeductible: parseResult.plan.out_deductible_individual,
        inOopMax: parseResult.plan.in_oop_max_individual,
        outOopMax: parseResult.plan.out_oop_max_individual,
        servicesExtracted: servicesCreated,
      },
      parseWarnings: parseResult.parseWarnings,
    };
  } catch (err) {
    console.error("Plan processing error:", err);
    await supabase.from("documents").update({ status: "error" }).eq("id", documentId);
    return {
      success: false,
      error: "Plan processing failed. Please try again.",
    };
  }
}
