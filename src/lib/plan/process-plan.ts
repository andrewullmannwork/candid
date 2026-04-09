/**
 * Shared plan document processing logic.
 * Split into two phases to stay within Vercel's 10-second function timeout:
 *   1. extractPlanData — regex metadata + Haiku service extraction (~5-8s)
 *   2. savePlanData — DB writes: plan, services, mismatch detection (~3-5s)
 *
 * The chunked pipeline calls these separately; the sync route calls processPlanDocumentData
 * which runs both in sequence (only safe for small documents).
 */

import { createServerClient } from "@/lib/supabase/server";
import { parseSBCText } from "@/lib/plan/sbc-parser";
import { parsePlanDocument } from "@/lib/plan/plan-doc-parser";
import { extractServicesWithClaude } from "@/lib/plan/claude-extractor";
import type { SBCParsedService } from "@/lib/plan/sbc-parser";

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
  insurerMismatch?: { mismatch: boolean; type?: string; existingInsurer: string; parsedInsurer: string; existingPlanName?: string; parsedPlanName?: string } | null;
}

export interface ExtractedPlanData {
  plan: Record<string, unknown>;
  services: SBCParsedService[];
  parseWarnings: string[];
  isFullPlanDoc: boolean;
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

// ── Phase 1: Extract ──────────────────────────────────────────────────────────
// Regex metadata parsing + Haiku service extraction. No DB writes except
// saving extracted JSON to documents.processing_extracted_services.

export async function extractPlanData(
  supabase: SupabaseClient,
  ocrText: string,
  documentId: string,
  classification: { classifiedType: string; confidence: number; mismatch: boolean },
  doc: { id: string; user_id: string; file_name: string }
): Promise<{ success: boolean; error?: string }> {
  try {
    const isFullPlanDoc = classification.classifiedType === "plan_document"
      || (classification.classifiedType !== "sbc" && ocrText.length > 50000);

    // Parse plan metadata (insurer, deductibles, OOP) with regex
    const parseResult = isFullPlanDoc
      ? parsePlanDocument(ocrText)
      : parseSBCText(ocrText, documentId);

    // Extract services with Haiku
    console.log("[extract-plan] Attempting Haiku extraction...");
    try {
      const claudeResult = await extractServicesWithClaude(
        ocrText,
        parseResult.plan.plan_name || null,
        isFullPlanDoc
      );
      if (claudeResult.fromClaude && claudeResult.services.length > 0) {
        parseResult.services = claudeResult.services;
        console.log(`[extract-plan] Haiku extracted ${claudeResult.services.length} services`);
      } else {
        console.warn("[extract-plan] Haiku returned no results — flagging for review");
        await notifyAndFlagForReview(supabase, documentId, classification, doc);
        return { success: false, error: "Haiku extraction returned no services" };
      }
    } catch (err) {
      console.error("[extract-plan] Haiku extraction failed:", err);
      await notifyAndFlagForReview(supabase, documentId, classification, doc);
      return { success: false, error: "Haiku extraction failed" };
    }

    // Save extracted data as JSON for the save stage
    const extractedData: ExtractedPlanData = {
      plan: parseResult.plan,
      services: parseResult.services,
      parseWarnings: parseResult.parseWarnings || [],
      isFullPlanDoc,
    };

    await supabase.from("documents").update({
      processing_extracted_services: extractedData,
      processing_step: "saving",
    }).eq("id", documentId);

    console.log(`[extract-plan] Saved ${parseResult.services.length} services to staging. Transitioning to save stage.`);
    return { success: true };
  } catch (err) {
    console.error("[extract-plan] Extraction error:", err);
    await supabase.from("documents").update({ status: "error", processing_error: "Extraction failed" }).eq("id", documentId);
    return { success: false, error: "Extraction failed" };
  }
}

async function notifyAndFlagForReview(
  supabase: SupabaseClient,
  documentId: string,
  classification: { classifiedType: string; confidence: number },
  doc: { id: string; user_id: string; file_name: string }
) {
  try {
    const { notifyAdminForReview } = await import("@/lib/notifications");
    const { data: profile } = await supabase
      .from("profiles")
      .select("email")
      .eq("user_id", doc.user_id)
      .single();
    await notifyAdminForReview(
      documentId,
      classification.classifiedType,
      classification.confidence,
      doc.file_name,
      profile?.email || "unknown"
    );
  } catch (notifyErr) {
    console.warn("[extract-plan] Notification failed:", notifyErr);
  }
  await supabase.from("documents").update({
    status: "pending_review",
    processing_error: "Haiku extraction failed or returned no services",
  }).eq("id", documentId);
}

// ── Phase 2: Save ─────────────────────────────────────────────────────────────
// Reads extracted JSON from documents.processing_extracted_services,
// creates plan + services + handles mismatch detection.

export async function savePlanData(
  supabase: SupabaseClient,
  doc: { id: string; user_id: string; file_name: string },
  documentId: string
): Promise<ProcessPlanResult> {
  try {
    // Read the extracted data saved by extractPlanData
    const { data: docRow } = await supabase
      .from("documents")
      .select("processing_extracted_services")
      .eq("id", documentId)
      .single();

    if (!docRow?.processing_extracted_services) {
      console.error("[save-plan] No extracted data found for document", documentId);
      await supabase.from("documents").update({ status: "error", processing_error: "No extracted data" }).eq("id", documentId);
      return { success: false, error: "No extracted data found" };
    }

    const extracted = docRow.processing_extracted_services as ExtractedPlanData;
    const { plan: planData, services, parseWarnings, isFullPlanDoc } = extracted;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const planInsert: Record<string, any> = {
      ...planData,
      user_id: doc.user_id,
      source: (isFullPlanDoc ? "plan_doc_upload" : "sbc_upload") as string,
      source_document_id: documentId,
      is_active: true,
      verification_status: "document_verified" as const,
    };

    // Backfill nulls from profile and detect mismatch
    const { data: userProfile } = await supabase
      .from("profiles")
      .select("deductible_individual, oop_max_individual, insurer, plan_name")
      .eq("user_id", doc.user_id)
      .single();

    if (userProfile) {
      planInsert.in_deductible_individual ??= userProfile.deductible_individual;
      planInsert.in_oop_max_individual ??= userProfile.oop_max_individual;
    }

    // Detect insurer or plan name mismatch
    const normalize = (s: string | null | undefined) =>
      (s || "").toLowerCase().replace(/\s*(insurance|company|inc|corp|health\s*plan)\s*/gi, "").trim();
    const profileInsurer = normalize(userProfile?.insurer);
    const parsedInsurer = normalize(planInsert.insurer_name);

    let mismatchData: {
      mismatch: boolean;
      type: "insurer" | "plan_name";
      existingInsurer: string;
      parsedInsurer: string;
      existingPlanName?: string;
      parsedPlanName?: string;
    } | null = null;

    if (profileInsurer && parsedInsurer
      && profileInsurer !== parsedInsurer
      && !profileInsurer.includes(parsedInsurer)
      && !parsedInsurer.includes(profileInsurer)) {
      mismatchData = {
        mismatch: true,
        type: "insurer",
        existingInsurer: userProfile?.insurer || "",
        parsedInsurer: planInsert.insurer_name || "",
      };
    } else if (userProfile?.plan_name && planInsert.plan_name
      && normalize(userProfile.plan_name) !== normalize(planInsert.plan_name)
      && !normalize(userProfile.plan_name).includes(normalize(planInsert.plan_name))
      && !normalize(planInsert.plan_name).includes(normalize(userProfile.plan_name))) {
      mismatchData = {
        mismatch: true,
        type: "plan_name",
        existingInsurer: userProfile?.insurer || "",
        parsedInsurer: planInsert.insurer_name || "",
        existingPlanName: userProfile.plan_name,
        parsedPlanName: planInsert.plan_name,
      };
    }

    if (mismatchData) {
      console.log(`[save-plan] Mismatch (${mismatchData.type}): profile="${mismatchData.type === "insurer" ? mismatchData.existingInsurer : mismatchData.existingPlanName}" doc="${mismatchData.type === "insurer" ? mismatchData.parsedInsurer : mismatchData.parsedPlanName}"`);
      await supabase.from("documents").update({ insurer_mismatch: mismatchData }).eq("id", documentId);
      planInsert.is_active = false;
    }

    // Deactivate existing active plans (only if no mismatch)
    if (!mismatchData) {
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
      await supabase.from("documents").update({ status: "error", processing_error: planError?.message || "Plan insert failed" }).eq("id", documentId);
      return { success: false, error: `Failed to save plan: ${planError?.message || "unknown"}`, parseWarnings };
    }

    // Link new plan to user's profile (only if no mismatch)
    if (!mismatchData) {
      await supabase
        .from("profiles")
        .update({ active_insurance_plan_id: newPlan.id })
        .eq("user_id", doc.user_id);
    }

    // Create plan_covered_services rows
    let servicesCreated = 0;
    if (services.length > 0) {
      const allSlugs = [...new Set(services.map((s) => s.serviceSlug))];
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

        console.log(`[save-plan] Auto-created ${newSlugs.length} service_catalog entries`);

        // Create CANDID concepts for new services
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

        // Backfill concept_id
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
        }

        const otherSlugs = newEntries.filter(e => e.category === "other").map(e => e.slug);
        if (otherSlugs.length > 0) {
          try {
            const { notifyUncategorizedServices } = await import("@/lib/notifications");
            await notifyUncategorizedServices(otherSlugs);
          } catch (notifyErr) {
            console.warn("[save-plan] Failed to notify about uncategorized services:", notifyErr);
          }
        }
      }

      // Build concept_id map
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

      // Deduplicate: keep highest-confidence per (slug, place_of_service)
      const deduped = new Map<string, SBCParsedService>();
      for (const s of services) {
        if (!slugToId.has(s.serviceSlug)) continue;
        const key = `${s.serviceSlug}|${s.placeOfService || "any"}`;
        const existing = deduped.get(key);
        if (!existing || s.confidence > existing.confidence) {
          deduped.set(key, s);
        }
      }

      const CONFIDENCE_THRESHOLD = 0.5;
      const confident = [...deduped.values()].filter(s => s.confidence >= CONFIDENCE_THRESHOLD);

      const serviceInserts = confident.map((s) => ({
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

    // Link document to insurance plan and clean up staging data
    await supabase
      .from("documents")
      .update({
        status: "processed",
        linked_insurance_plan_id: newPlan.id,
        processing_step: null,
        processing_ocr_text: null,
        processing_extracted_services: null,
      })
      .eq("id", documentId);

    console.log(`[save-plan] Done. Plan=${newPlan.id}, services=${servicesCreated}, mismatch=${mismatchData?.type || "none"}`);

    return {
      success: true,
      planId: newPlan.id,
      servicesCreated,
      planData: {
        planName: planInsert.plan_name,
        planType: planInsert.plan_type,
        inDeductible: planInsert.in_deductible_individual,
        outDeductible: planInsert.out_deductible_individual,
        inOopMax: planInsert.in_oop_max_individual,
        outOopMax: planInsert.out_oop_max_individual,
        servicesExtracted: servicesCreated,
      },
      parseWarnings,
      insurerMismatch: mismatchData,
    };
  } catch (err) {
    console.error("[save-plan] Save error:", err);
    await supabase.from("documents").update({ status: "error", processing_error: "Save failed" }).eq("id", documentId);
    return { success: false, error: "Plan save failed. Please try again." };
  }
}

// ── Convenience wrapper ───────────────────────────────────────────────────────
// Runs both phases in sequence. Only safe for small documents that won't
// exceed Vercel's 10-second timeout. The chunked pipeline calls each phase
// separately via QStash.

export async function processPlanDocumentData(
  supabase: SupabaseClient,
  doc: { id: string; user_id: string; file_name: string },
  ocrText: string,
  documentId: string,
  classification: { classifiedType: string; confidence: number; mismatch: boolean }
): Promise<ProcessPlanResult> {
  const extractResult = await extractPlanData(supabase, ocrText, documentId, classification, doc);
  if (!extractResult.success) {
    return {
      success: true, // Still "success" in the sense that we handled it gracefully
      servicesCreated: 0,
      parseWarnings: ["Service extraction requires admin review"],
    };
  }
  return savePlanData(supabase, doc, documentId);
}
