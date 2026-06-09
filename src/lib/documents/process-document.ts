// Internal document-processing core — extracted from POST /api/documents/process (S180, B9-F01).
//
// SECURITY: this is a TRUSTED INTERNAL function. It performs NO authentication
// or authorization of its own and operates entirely within `doc.user_id`'s
// scope (it downloads the owner's file and writes claims / plans / pricing for
// that owner). Every caller MUST gate access before invoking it:
//   - the public route (/api/documents/process) requires a Firebase bearer
//     token and verifies `doc.user_id === authedUser.id` before calling;
//   - the admin route (/api/admin/processing) is `is_admin`-gated and passes
//     `adminOverride: true` to bypass the per-day cost budget.
//
// Extracted to remove the forgeable `x-internal` / `x-admin-override` header
// trust-bypass (B9-F01): the admin path now calls this core directly instead of
// making an internal HTTP hop carrying a plaintext override header.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DocumentRow } from "@/lib/supabase/types";
import { getUserContextByPk } from "@/lib/users/resolve-user-by-pk";
import { extractTextFromDocument } from "@/lib/ocr";
import { assessAdversarialPdf } from "@/lib/parser/adversarial-pdf-ingest";
import { parseBillFromOCR } from "@/lib/billing/parser";
import { parseBillWithHaiku } from "@/lib/billing/haiku-bill-parser";
import { runAudit } from "@/lib/audit";
import { collectPricingData } from "@/lib/care/collector";
import { checkProcessingBudget, recordProcessingUsage } from "@/lib/config/processing-usage";
import { classifyDocument } from "@/lib/classifier";
import { processPlanDocumentData } from "@/lib/plan/process-plan";

export interface ProcessDocumentResult {
  status: number;
  body: Record<string, unknown>;
}

const VALID_BILL_TYPES = ["eob", "itemized_bill", "sbc", "plan_document"];

/**
 * Runs OCR → classify → (plan parse | bill audit + persist) on an already-
 * authorized document. Returns a `{ status, body }` pair the caller serializes
 * to a NextResponse — never throws (internal errors resolve to status 500).
 */
export async function processDocument(
  supabase: SupabaseClient,
  { doc, billType, adminOverride }: { doc: DocumentRow; billType: string; adminOverride: boolean },
): Promise<ProcessDocumentResult> {
  const documentId = doc.id;

  // billType allowlist — validated HERE (not only at the public route) because
  // the admin path derives billType from `doc.doc_type`, which can be
  // 'insurance_card' / 'other'. Without this, those would fall through to the
  // bill-audit path instead of returning the 400 the inner route used to give.
  if (!VALID_BILL_TYPES.includes(billType)) {
    return {
      status: 400,
      body: { error: "billType must be 'eob', 'itemized_bill', 'sbc', or 'plan_document'" },
    };
  }

  try {
    // Check processing budget (cost protection). adminOverride bypasses the cap
    // and is set ONLY by the is_admin-gated admin route.
    if (!adminOverride) {
      const budget = await checkProcessingBudget(1);
      if (!budget.allowed) {
        await supabase
          .from("documents")
          .update({ status: "queued" })
          .eq("id", documentId);
        return {
          status: 429,
          body: {
            success: false,
            queued: true,
            error: budget.reason,
            usage: {
              dailyUsed: budget.dailyUsed,
              dailyLimit: budget.dailyLimit,
              monthlyUsed: budget.monthlyUsed,
              monthlyLimit: budget.monthlyLimit,
            },
          },
        };
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
      return { status: 500, body: { error: "Could not download document" } };
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
        return {
          status: 400,
          body: {
            success: false,
            error: `This document is ${estimatedPages} pages, which exceeds the 90-page limit. Please upload a shorter document or just the relevant sections.`,
          },
        };
      }
    }

    // ── Ing-G.2/3 — adversarial-PDF assessment (flag-gated; non-fatal; PDF only).
    //    Co-located with the legacy parse path so coverage matches process-chunk. ──
    if (doc.file_name?.toLowerCase().endsWith(".pdf")) {
      await assessAdversarialPdf(supabase, documentId, buffer);
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

      return {
        status: isConfig ? 503 : 500,
        body: {
          error: isConfig
            ? "Document processing is not configured yet. Please contact support."
            : `OCR failed: ${msg}`,
        },
      };
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
      return { status: 422, body: { error: "Could not extract text from document" } };
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
        return {
          status: 500,
          body: { success: false, error: planResult.error, parseWarnings: planResult.parseWarnings },
        };
      }
      return {
        status: 200,
        body: {
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
        },
      };
    }

    // EOB / Itemized Bill: run audit pipeline
    // Use Haiku for structured extraction (handles any format), fall back to regex
    const haikuParsed = await parseBillWithHaiku(ocrResult.text, documentId, doc.user_id, billType as "eob" | "itemized_bill");
    const parsedBill = haikuParsed || parseBillFromOCR(ocrResult, documentId, doc.user_id, billType as "eob" | "itemized_bill");

    const auditReport = await runAudit(parsedBill);

    // Persist audit results to claims + claim_line_items tables (feature-flagged)
    let claimId: string | null = null;
    try {
      const { isFeatureEnabled } = await import("@/lib/config/product-flags");
      const userForFlag = await getUserContextByPk(supabase, doc.user_id, "process:claims_persistence");
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

    return {
      status: 200,
      body: {
        success: true,
        report: auditReport,
        claimId,
        pricingDataCollected: pricingCollected,
        classification: {
          classifiedType: classification.classifiedType,
          confidence: classification.confidence,
          mismatch: classification.mismatch,
        },
      },
    };
  } catch (error) {
    console.error("Document processing error:", error);
    return { status: 500, body: { error: "Processing failed. Please try again." } };
  }
}
