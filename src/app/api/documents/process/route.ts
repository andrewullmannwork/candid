// POST /api/documents/process
// Triggers OCR extraction on an uploaded document, then:
// - Classifies the document type (SBC, EOB, bill, card)
// - If SBC: parses plan data → creates insurance_plans + plan_covered_services
// - If bill/EOB: runs audit pipeline
// Requires authenticated user + health data consent

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { extractTextFromDocument } from "@/lib/ocr";
import { parseBillFromOCR } from "@/lib/billing/parser";
import { runAudit } from "@/lib/audit";
import { collectPricingData } from "@/lib/care/collector";
import { checkProcessingBudget, recordProcessingUsage } from "@/lib/config/processing-usage";
import { classifyDocument } from "@/lib/classifier";
import { parseSBCText } from "@/lib/plan/sbc-parser";
import { parsePlanDocument } from "@/lib/plan/plan-doc-parser";

export async function POST(req: NextRequest) {
  try {
    const { documentId, billType } = await req.json();

    if (!documentId || !billType) {
      return NextResponse.json(
        { error: "documentId and billType are required" },
        { status: 400 }
      );
    }

    if (!["eob", "itemized_bill", "sbc", "plan_document"].includes(billType)) {
      return NextResponse.json(
        { error: "billType must be 'eob', 'itemized_bill', 'sbc', or 'plan_document'" },
        { status: 400 }
      );
    }

    const supabase = createServerClient();

    // Verify document exists and get metadata
    const { data: doc, error: docError } = await supabase
      .from("documents")
      .select("*")
      .eq("id", documentId)
      .single();

    if (docError || !doc) {
      return NextResponse.json(
        { error: "Document not found" },
        { status: 404 }
      );
    }

    // Check processing budget (cost protection)
    const adminOverride = req.headers.get("x-admin-override") === "true";
    if (!adminOverride) {
      const budget = await checkProcessingBudget(1);
      if (!budget.allowed) {
        await supabase
          .from("documents")
          .update({ status: "queued" })
          .eq("id", documentId);
        return NextResponse.json({
          success: false,
          queued: true,
          error: budget.reason,
          usage: {
            dailyUsed: budget.dailyUsed,
            dailyLimit: budget.dailyLimit,
            monthlyUsed: budget.monthlyUsed,
            monthlyLimit: budget.monthlyLimit,
          },
        }, { status: 429 });
      }
    }

    // Update status to processing
    await supabase
      .from("documents")
      .update({ status: "processing" })
      .eq("id", documentId);

    // Download file from Supabase Storage
    const { data: fileData, error: fileError } = await supabase.storage
      .from("documents")
      .download(doc.storage_path);

    if (fileError || !fileData) {
      await supabase
        .from("documents")
        .update({ status: "error" })
        .eq("id", documentId);
      return NextResponse.json(
        { error: "Could not download document" },
        { status: 500 }
      );
    }

    // Convert to buffer for OCR
    const buffer = Buffer.from(await fileData.arrayBuffer());

    // ── Page limit check (hard cap at 90 pages to prevent abuse) ────────────
    if (doc.file_name?.toLowerCase().endsWith(".pdf")) {
      const pdfStr = buffer.toString("latin1");
      const pageMatches = pdfStr.match(/\/Type\s*\/Page\b/g);
      const pagesTreeMatches = pdfStr.match(/\/Type\s*\/Pages\b/g);
      const estimatedPages = pageMatches
        ? pageMatches.length - (pagesTreeMatches?.length || 0)
        : 0;

      if (estimatedPages > 90) {
        await supabase.from("documents").update({ status: "error" }).eq("id", documentId);
        return NextResponse.json({
          success: false,
          error: `This document is ${estimatedPages} pages, which exceeds the 90-page limit. Please upload a shorter document or just the relevant sections.`,
        }, { status: 400 });
      }
    }

    // ── Run OCR ──────────────────────────────────────────────────────────────
    // Document AI handles large PDFs by splitting into 15-page chunks automatically.
    let ocrResult;
    try {
      ocrResult = await extractTextFromDocument(buffer, "application/pdf");
    } catch (ocrErr) {
      const msg = ocrErr instanceof Error ? ocrErr.message : "OCR failed";
      const isConfig = msg.includes("DOCUMENT_AI_PROCESSOR_ID") || msg.includes("env var");
      await supabase
        .from("documents")
        .update({ status: "error" })
        .eq("id", documentId);

      return NextResponse.json(
        { error: isConfig
          ? "Document processing is not configured yet. Please contact support."
          : `OCR failed: ${msg}` },
        { status: isConfig ? 503 : 500 }
      );
    }

    // Record OCR usage for cost tracking
    const pageCount = ocrResult.pages?.length || 1;
    await recordProcessingUsage(pageCount);

    // ── Classify document ────────────────────────────────────────────────────
    const classification = classifyDocument({
      text: ocrResult.text,
      fileName: doc.file_name,
      userSelectedType: billType,
    });

    // Save classification results to document
    await supabase
      .from("documents")
      .update({
        classified_type: classification.classifiedType,
        classification_confidence: classification.confidence,
        classification_signals: classification.signals,
        type_mismatch: classification.mismatch,
      })
      .eq("id", documentId);

    // ── Route by document type ───────────────────────────────────────────────

    // SBC and plan documents: parse plan data instead of running audit
    // Route to SBC parser if user selected SBC/plan_document OR classifier detected it
    const isPlanDoc = billType === "sbc" || billType === "plan_document"
      || classification.classifiedType === "sbc"
      || classification.classifiedType === "plan_document";

    if (isPlanDoc) {
      return await handleSBCDocument(supabase, doc, ocrResult.text, documentId, classification);
    }

    // EOB / Itemized Bill: run audit pipeline
    const parsedBill = parseBillFromOCR(
      ocrResult,
      documentId,
      doc.user_id,
      billType
    );

    const auditReport = await runAudit(parsedBill);

    // Collect anonymized pricing data for Candid Care (non-blocking)
    let pricingCollected = 0;
    try {
      const { data: profile } = await supabase
        .from("profiles")
        .select("state")
        .eq("user_id", doc.user_id)
        .single();

      const result = await collectPricingData(
        parsedBill,
        profile?.state || null
      );
      pricingCollected = result.collected;
    } catch {
      // Pricing collection is best-effort
    }

    // Update document status
    await supabase
      .from("documents")
      .update({ status: "processed" })
      .eq("id", documentId);

    return NextResponse.json({
      success: true,
      report: auditReport,
      pricingDataCollected: pricingCollected,
      classification: {
        classifiedType: classification.classifiedType,
        confidence: classification.confidence,
        mismatch: classification.mismatch,
      },
    });
  } catch (error) {
    console.error("Document processing error:", error);
    return NextResponse.json(
      { error: "Processing failed. Please try again." },
      { status: 500 }
    );
  }
}

// ── SBC document handler ───────────────────────────────────────────────────────

type SupabaseClient = ReturnType<typeof createServerClient>;

async function handleSBCDocument(
  supabase: SupabaseClient,
  doc: { id: string; user_id: string; file_name: string },
  ocrText: string,
  documentId: string,
  classification: { classifiedType: string; confidence: number; mismatch: boolean }
) {
  try {
    // Parse plan data — use plan-doc parser for plan certificates, SBC parser for SBCs
    const isFullPlanDoc = classification.classifiedType === "plan_document"
      || (classification.classifiedType !== "sbc" && ocrText.length > 50000);
    const parseResult = isFullPlanDoc
      ? parsePlanDocument(ocrText)
      : parseSBCText(ocrText, documentId);

    // Create insurance_plans record
    const planInsert = {
      ...parseResult.plan,
      user_id: doc.user_id,
      source: (isFullPlanDoc ? "plan_doc_upload" : "sbc_upload") as string,
      source_document_id: documentId,
      is_active: true,
      verification_status: "unverified" as const,
    };

    // Deactivate any existing active plans for this user
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
      return NextResponse.json({
        success: false,
        error: "Failed to save parsed plan data",
        parseWarnings: parseResult.parseWarnings,
      }, { status: 500 });
    }

    // Create plan_covered_services rows
    let servicesCreated = 0;
    if (parseResult.services.length > 0) {
      // Batch lookup service_catalog IDs by slug
      const slugs = [...new Set(parseResult.services.map((s) => s.serviceSlug))];
      const { data: serviceCatalog } = await supabase
        .from("service_catalog")
        .select("id, slug")
        .in("slug", slugs);

      const slugToId = new Map(serviceCatalog?.map((s) => [s.slug, s.id]) || []);

      // Auto-create service_catalog entries for slugs not yet in the catalog
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
        console.log(`[process] Auto-created ${created?.length || 0} service_catalog entries: ${newSlugs.slice(0, 5).join(", ")}${newSlugs.length > 5 ? "..." : ""}`);

        // Flag services that landed in "other" category for admin review
        const otherSlugs = newEntries.filter(e => e.category === "other").map(e => e.slug);
        if (otherSlugs.length > 0) {
          try {
            const { notifyUncategorizedServices } = await import("@/lib/notifications");
            await notifyUncategorizedServices(otherSlugs);
          } catch (notifyErr) {
            console.warn("[process] Failed to notify about uncategorized services:", notifyErr);
          }
        }
      }

      // Deduplicate: keep highest-confidence entry per (slug, place_of_service)
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
      })
      .eq("id", documentId);

    // Set as active plan on profile (if user doesn't already have one or we just created a new one)
    await supabase
      .from("profiles")
      .update({ active_insurance_plan_id: newPlan.id })
      .eq("user_id", doc.user_id);

    return NextResponse.json({
      success: true,
      report: null,
      sbcParsed: true,
      insurancePlanId: newPlan.id,
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
      confidence: parseResult.confidence,
      classification: {
        classifiedType: classification.classifiedType,
        confidence: classification.confidence,
        mismatch: classification.mismatch,
      },
    });
  } catch (err) {
    console.error("SBC processing error:", err);
    await supabase.from("documents").update({ status: "error" }).eq("id", documentId);
    return NextResponse.json({
      success: false,
      error: "SBC processing failed. Please try again.",
    }, { status: 500 });
  }
}

// ── Helper: infer service category from slug ─────────────────────────────────

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
