/**
 * Shared plan document processing logic.
 * Extracted from /api/documents/process so both the sync process route
 * and the chunked process-chunk route can use it.
 */

import { createServerClient } from "@/lib/supabase/server";
import { parseSBCText } from "@/lib/plan/sbc-parser";
import { parsePlanDocument } from "@/lib/plan/plan-doc-parser";
import { extractServicesWithClaude } from "@/lib/plan/claude-extractor";
import { FLAGS } from "@/lib/config/feature-flags";

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
  insurerMismatch?: { mismatch: boolean; existingInsurer: string; parsedInsurer: string } | null;
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

    // Parse plan metadata (insurer, deductibles, OOP) with regex — always needed
    const parseResult = isFullPlanDoc
      ? parsePlanDocument(ocrText)
      : parseSBCText(ocrText, documentId);

    // Extract services: Haiku primary, regex fallback
    const claudeEnabled = process.env.CLAUDE_EXTRACTION_ENABLED === "true" || FLAGS.CLAUDE_EXTRACTION_ENABLED;
    if (claudeEnabled) {
      try {
        console.log("[process-plan] Attempting Haiku primary extraction...");
        const claudeResult = await extractServicesWithClaude(
          ocrText,
          parseResult.plan.plan_name || null,
          isFullPlanDoc
        );
        if (claudeResult.fromClaude && claudeResult.services.length > 0) {
          parseResult.services = claudeResult.services;
          console.log(`[process-plan] Haiku extracted ${claudeResult.services.length} services (primary)`);
        } else {
          console.log(`[process-plan] Haiku returned no results — using regex fallback (${parseResult.services.length} services)`);
        }
      } catch (err) {
        console.warn("[process-plan] Haiku extraction failed — using regex fallback:", err);
      }
    } else {
      console.log(`[process-plan] Claude disabled — using regex parser (${parseResult.services.length} services)`);
    }

    const planInsert = {
      ...parseResult.plan,
      user_id: doc.user_id,
      source: (isFullPlanDoc ? "plan_doc_upload" : "sbc_upload") as string,
      source_document_id: documentId,
      is_active: true,
      verification_status: "document_verified" as const,
    };

    // Backfill nulls from profile and detect insurer mismatch
    const { data: userProfile } = await supabase
      .from("profiles")
      .select("deductible_individual, oop_max_individual, insurer")
      .eq("user_id", doc.user_id)
      .single();

    if (userProfile) {
      planInsert.in_deductible_individual ??= userProfile.deductible_individual;
      planInsert.in_oop_max_individual ??= userProfile.oop_max_individual;
    }

    // Detect insurer mismatch (card says X, document says Y)
    const normalizeInsurer = (s: string | null | undefined) =>
      (s || "").toLowerCase().replace(/\s*(insurance|company|inc|corp|health\s*plan)\s*/gi, "").trim();
    const profileInsurer = normalizeInsurer(userProfile?.insurer);
    const parsedInsurer = normalizeInsurer(parseResult.plan.insurer_name);
    const insurerMismatch = profileInsurer && parsedInsurer
      && profileInsurer !== parsedInsurer
      && !profileInsurer.includes(parsedInsurer)
      && !parsedInsurer.includes(profileInsurer)
      ? { mismatch: true, existingInsurer: userProfile?.insurer || "", parsedInsurer: parseResult.plan.insurer_name || "" }
      : null;

    if (insurerMismatch) {
      console.log(`[process-plan] Insurer mismatch: card="${userProfile?.insurer}" doc="${parseResult.plan.insurer_name}"`);
      // Save mismatch info on document for frontend to detect
      await supabase.from("documents").update({ insurer_mismatch: insurerMismatch }).eq("id", documentId);
      // Don't auto-activate this plan — user must choose
      planInsert.is_active = false;
    }

    // Deactivate existing active plans (only if no mismatch — matching insurer replaces)
    if (!insurerMismatch) {
      await supabase
        .from("insurance_plans")
        .update({ is_active: false })
        .eq("user_id", doc.user_id)
        .eq("is_active", true);
    }

    const { data: newPlan, error: planError } = await supabase
      .from("insurance_plans")
      .insert(planInsert)
      .select("id")
      .single();

    if (planError || !newPlan) {
      console.error("Failed to create insurance plan:", planError);
      console.error("Plan insert data:", JSON.stringify(planInsert).slice(0, 500));
      await supabase.from("documents").update({ status: "error", processing_error: planError?.message || "Plan insert failed" }).eq("id", documentId);
      return {
        success: false,
        error: `Failed to save parsed plan data: ${planError?.message || "unknown"}`,
        parseWarnings: parseResult.parseWarnings,
      };
    }

    // Link new plan to user's profile (only if no insurer mismatch)
    if (!insurerMismatch) {
      await supabase
        .from("profiles")
        .update({ active_insurance_plan_id: newPlan.id })
        .eq("user_id", doc.user_id);
    }

    // Create plan_covered_services rows
    let servicesCreated = 0;
    if (parseResult.services.length > 0) {
      const allSlugs = [...new Set(parseResult.services.map((s) => s.serviceSlug))];

      // Auto-create any service_catalog entries that don't exist yet
      // Query in batches to avoid Supabase URL length limits
      const BATCH_SIZE = 50;
      const slugToId = new Map<string, string>();

      for (let i = 0; i < allSlugs.length; i += BATCH_SIZE) {
        const batch = allSlugs.slice(i, i + BATCH_SIZE);
        const { data: existing } = await supabase
          .from("service_catalog")
          .select("id, slug")
          .in("slug", batch);
        for (const s of existing || []) {
          slugToId.set(s.slug, s.id);
        }
      }

      const newSlugs = allSlugs.filter((slug) => !slugToId.has(slug));

      if (newSlugs.length > 0) {
        const newEntries = newSlugs.map((slug) => ({
          slug,
          name: slug.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()),
          category: inferServiceCategory(slug),
          description: "",
          is_preventive_eligible: false,
        }));

        // Insert in batches
        for (let i = 0; i < newEntries.length; i += BATCH_SIZE) {
          const batch = newEntries.slice(i, i + BATCH_SIZE);
          const { data: created } = await supabase
            .from("service_catalog")
            .upsert(batch, { onConflict: "slug" })
            .select("id, slug");
          for (const entry of created || []) {
            slugToId.set(entry.slug, entry.id);
          }
        }

        console.log(`[process-plan] Auto-created ${newSlugs.length} service_catalog entries: ${newSlugs.slice(0, 5).join(", ")}${newSlugs.length > 5 ? "..." : ""}`);

        // Create matching CANDID concepts for new services
        const conceptInserts = newEntries.map((entry) => ({
          vocabulary_id: "CANDID",
          concept_code: entry.slug,
          concept_name: entry.name,
          concept_class: "service",
          domain: "service",
        }));
        for (let i = 0; i < conceptInserts.length; i += BATCH_SIZE) {
          const batch = conceptInserts.slice(i, i + BATCH_SIZE);
          await supabase.from("concepts").upsert(batch, { onConflict: "vocabulary_id,concept_code" });
        }

        // Backfill concept_id on new service_catalog rows
        const { data: newConcepts } = await supabase
          .from("concepts")
          .select("id, concept_code")
          .eq("vocabulary_id", "CANDID")
          .eq("concept_class", "service")
          .in("concept_code", newSlugs);
        if (newConcepts) {
          for (const concept of newConcepts) {
            await supabase
              .from("service_catalog")
              .update({ concept_id: concept.id })
              .eq("slug", concept.concept_code)
              .is("concept_id", null);
          }
          console.log(`[process-plan] Created ${newConcepts.length} CANDID concepts + backfilled concept_id`);
        }

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

      console.log(`[process-plan] slugToId has ${slugToId.size} entries for ${allSlugs.length} service slugs`);

      // Build concept_id map: slug → concept UUID
      const conceptIdMap = new Map<string, string>();
      for (let i = 0; i < allSlugs.length; i += BATCH_SIZE) {
        const batch = allSlugs.slice(i, i + BATCH_SIZE);
        const { data: svcWithConcepts } = await supabase
          .from("service_catalog")
          .select("slug, concept_id")
          .in("slug", batch);
        for (const svc of svcWithConcepts || []) {
          if (svc.concept_id) conceptIdMap.set(svc.slug, svc.concept_id);
        }
      }
      console.log(`[process-plan] conceptIdMap has ${conceptIdMap.size} entries for ${allSlugs.length} slugs`);

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

      // Only add high-confidence services (>= 0.5) to user's plan benefits.
      // Low-confidence (fallback-generated) services exist in service_catalog
      // for admin review but don't auto-populate into user benefits.
      const CONFIDENCE_THRESHOLD = 0.5;
      const confident = [...deduped.values()].filter(s => s.confidence >= CONFIDENCE_THRESHOLD);
      const uncertain = [...deduped.values()].filter(s => s.confidence < CONFIDENCE_THRESHOLD);

      if (uncertain.length > 0) {
        console.log(`[process-plan] ${uncertain.length} low-confidence services sent to admin review: ${uncertain.slice(0, 5).map(s => s.serviceSlug).join(", ")}${uncertain.length > 5 ? "..." : ""}`);
      }

      const serviceInserts = confident
        .map((s) => ({
          insurance_plan_id: newPlan.id,
          service_id: slugToId.get(s.serviceSlug)!,
          concept_id: conceptIdMap.get(s.serviceSlug) || null,
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

    // Set as active plan on profile (only if no mismatch)
    if (!insurerMismatch) {
      await supabase
        .from("profiles")
        .update({ active_insurance_plan_id: newPlan.id })
        .eq("user_id", doc.user_id);
    }

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
      insurerMismatch,
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
