// POST /api/documents/process
// Triggers OCR extraction on an uploaded document, then runs audit
// Requires authenticated user + health data consent

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { extractTextFromDocument } from "@/lib/ocr";
import { parseBillFromOCR } from "@/lib/billing/parser";
import { runAudit } from "@/lib/audit";

export async function POST(req: NextRequest) {
  try {
    const { documentId, billType } = await req.json();

    if (!documentId || !billType) {
      return NextResponse.json(
        { error: "documentId and billType are required" },
        { status: 400 }
      );
    }

    if (!["eob", "itemized_bill"].includes(billType)) {
      return NextResponse.json(
        { error: "billType must be 'eob' or 'itemized_bill'" },
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
    const ocrResult = await extractTextFromDocument(buffer, "application/pdf");

    // Parse bill from OCR text
    const parsedBill = parseBillFromOCR(
      ocrResult,
      documentId,
      doc.user_id,
      billType
    );

    // Run audit
    const auditReport = await runAudit(parsedBill);

    // Update document status
    await supabase
      .from("documents")
      .update({ status: "processed" })
      .eq("id", documentId);

    return NextResponse.json({
      success: true,
      report: auditReport,
    });
  } catch (error) {
    console.error("Document processing error:", error);
    return NextResponse.json(
      { error: "Processing failed. Please try again." },
      { status: 500 }
    );
  }
}
