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
import { parseBillWithHaiku } from "@/lib/billing/haiku-bill-parser";
import { runAudit } from "@/lib/audit";
import { collectPricingData } from "@/lib/care/collector";
import { checkProcessingBudget, recordProcessingUsage } from "@/lib/config/processing-usage";
import { classifyDocument } from "@/lib/classifier";
import { processPlanDocumentData } from "@/lib/plan/process-plan";
import { getAdminAuth } from "@/lib/firebase/admin";

export const maxDuration = 300;

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

    // Auth check: verify the authenticated user owns this document
    const authHeader = req.headers.get("authorization");
    const isInternalCall = req.headers.get("x-internal") === "true";
    let authenticatedUserId: string | null = null;
    if (!isInternalCall && authHeader?.startsWith("Bearer ")) {
      try {
        const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
        const { data: authUser } = await supabase.from("users").select("id").eq("firebase_uid", decoded.uid).single();
        if (!authUser) {
          return NextResponse.json({ error: "User not found" }, { status: 404 });
        }
        authenticatedUserId = authUser.id;
      } catch {
        return NextResponse.json({ error: "Invalid token" }, { status: 401 });
      }
    }

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

    // Ownership check: authenticated user must own the document
    if (authenticatedUserId && doc.user_id !== authenticatedUserId) {
      return NextResponse.json({ error: "Not authorized for this document" }, { status: 403 });
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

    // Guard: empty OCR text — document is unreadable
    if (!ocrResult.text || ocrResult.text.trim().length < 50) {
      await supabase
        .from("documents")
        .update({ status: "error", processing_error: "Could not extract text from document" })
        .eq("id", documentId);
      return NextResponse.json({ error: "Could not extract text from document" }, { status: 422 });
    }

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
      // Confidence-tiered routing: skip canonical writes for medium-confidence docs
      const skipCanonical = classification.confidence < 0.8;
      const planResult = await processPlanDocumentData(supabase, doc, ocrResult.text, documentId, classification, { skipCanonical });
      if (!planResult.success) {
        return NextResponse.json({ success: false, error: planResult.error, parseWarnings: planResult.parseWarnings }, { status: 500 });
      }
      return NextResponse.json({
        success: true,
        report: null,
        sbcParsed: true,
        insurancePlanId: planResult.planId,
        planData: planResult.planData,
        parseWarnings: planResult.parseWarnings,
        classification: {
          classifiedType: classification.classifiedType,
          confidence: classification.confidence,
          mismatch: classification.mismatch,
        },
      });
    }

    // EOB / Itemized Bill: run audit pipeline
    // Use Haiku for structured extraction (handles any format), fall back to regex
    const haikuParsed = await parseBillWithHaiku(ocrResult.text, documentId, doc.user_id, billType as "eob" | "itemized_bill");
    const parsedBill = haikuParsed || parseBillFromOCR(ocrResult, documentId, doc.user_id, billType);

    const auditReport = await runAudit(parsedBill);

    // Persist audit results to claims + claim_line_items tables (feature-flagged)
    let claimId: string | null = null;
    try {
      const { isFeatureEnabled } = await import("@/lib/config/product-flags");
      const { data: userForFlag } = await supabase.from("users").select("email").eq("firebase_uid", doc.user_id).single();
      const claimsEnabled = await isFeatureEnabled("claims_persistence", userForFlag?.email || undefined);
      if (!claimsEnabled) throw new Error("feature_disabled");

      const { persistAuditResults } = await import("@/lib/claims/persist");
      const { resolveClaimPlanContext } = await import("@/lib/claims/plan-year-resolver");

      // Get user's active insurance plan for fallback
      const { data: profileForClaim } = await supabase
        .from("profiles")
        .select("active_insurance_plan_id")
        .eq("user_id", doc.user_id)
        .single();

      // T3.7: match historical plan by DOS before falling back to active.
      const { planId, planYear } = await resolveClaimPlanContext(supabase, {
        userId: doc.user_id,
        dateOfService: parsedBill.serviceDate || null,
        fallbackActivePlanId: profileForClaim?.active_insurance_plan_id || null,
      });

      const persistResult = await persistAuditResults(supabase, {
        userId: doc.user_id,
        insurancePlanId: planId || undefined,
        planYear,
        documentId,
        parsedBill,
        auditReport,
      });
      claimId = persistResult?.claimId || null;
    } catch (err) {
      if (err instanceof Error && err.message !== "feature_disabled") {
        console.error("[claims-persist] Failed to persist audit results (non-fatal):", err);
      }
    }

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
      claimId,
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

