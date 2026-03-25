// POST /api/documents/process
// Triggers OCR extraction on an uploaded document, then runs audit
// Requires authenticated user + health data consent

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { extractTextFromDocument } from "@/lib/ocr";
import { parseBillFromOCR } from "@/lib/billing/parser";
import { runAudit } from "@/lib/audit";
import { collectPricingData } from "@/lib/care/collector";
import { checkProcessingBudget, recordProcessingUsage } from "@/lib/config/processing-usage";

export async function POST(req: NextRequest) {
  try {
    const { documentId, billType } = await req.json();

    if (!documentId || !billType) {
      return NextResponse.json(
        { error: "documentId and billType are required" },
        { status: 400 }
      );
    }

    if (!["eob", "itemized_bill", "sbc"].includes(billType)) {
      return NextResponse.json(
        { error: "billType must be 'eob', 'itemized_bill', or 'sbc'" },
        { status: 400 }
      );
    }

    // SBC documents don't go through the audit pipeline
    if (billType === "sbc") {
      return NextResponse.json({
        success: true,
        report: null,
        message: "SBC document uploaded successfully. It will be processed through the benefits pipeline.",
        pricingDataCollected: 0,
      });
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
        // Queue the document instead of processing
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

    // Run OCR
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

    // Parse bill from OCR text
    const parsedBill = parseBillFromOCR(
      ocrResult,
      documentId,
      doc.user_id,
      billType
    );

    // Run audit
    const auditReport = await runAudit(parsedBill);

    // Collect anonymized pricing data for Candid Care
    // Non-blocking: pricing collection failure should not break the audit pipeline
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
      // Pricing collection is best-effort — don't fail the request
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
    });
  } catch (error) {
    console.error("Document processing error:", error);
    return NextResponse.json(
      { error: "Processing failed. Please try again." },
      { status: 500 }
    );
  }
}
