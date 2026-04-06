/**
 * POST /api/documents/process-chunk
 *
 * Chunked document processing for large PDFs that exceed Vercel's 10s timeout.
 * Each invocation does ONE unit of work (~5-8s), saves progress to DB, and returns.
 * The next step is triggered by dashboard polling or the daily safety-net cron.
 *
 * State machine:
 *   queued/null      → download, count pages, OCR chunk 0    → ocr_chunk_1
 *   ocr_chunk_N      → OCR chunk N, append text               → ocr_chunk_{N+1} or classifying
 *   classifying       → classify full text, save results       → parsing
 *   parsing           → parse plan data, write to DB           → processed
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { extractTextFromDocument } from "@/lib/ocr";
import { splitPDF, estimatePageCount } from "@/lib/ocr/document-ai";
import { classifyDocument } from "@/lib/classifier";
import { processPlanDocumentData } from "@/lib/plan/process-plan";
import { recordProcessingUsage } from "@/lib/config/processing-usage";

const CHUNK_SIZE = 15; // pages per OCR chunk

export async function POST(req: NextRequest) {
  try {
    const { documentId } = await req.json();
    if (!documentId) {
      return NextResponse.json({ error: "documentId required" }, { status: 400 });
    }

    const supabase = createServerClient();

    // Fetch document with current processing state
    const { data: doc, error: docError } = await supabase
      .from("documents")
      .select("*")
      .eq("id", documentId)
      .single();

    if (docError || !doc) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    // Only process documents in the right state
    if (!["queued", "processing"].includes(doc.status)) {
      return NextResponse.json({ skip: true, reason: `Status is ${doc.status}` });
    }

    const step = doc.processing_step || "init";

    // ── STEP: INIT — download file, count pages, OCR first chunk ──────────
    if (step === "init") {
      // Concurrency guard: atomically claim this document
      const { data: claimed } = await supabase
        .from("documents")
        .update({
          status: "processing",
          processing_step: "working_init",
          processing_started_at: new Date().toISOString(),
        })
        .eq("id", documentId)
        .is("processing_step", null)
        .eq("status", "queued")
        .select("id");

      if (!claimed || claimed.length === 0) {
        return NextResponse.json({ skip: true, reason: "Already being processed" });
      }

      // Download file
      const { data: fileData, error: fileError } = await supabase.storage
        .from("documents")
        .download(doc.storage_path);

      if (fileError || !fileData) {
        await supabase.from("documents").update({ status: "error", processing_error: "Download failed" }).eq("id", documentId);
        return NextResponse.json({ error: "Download failed" }, { status: 500 });
      }

      const buffer = Buffer.from(await fileData.arrayBuffer());
      const totalPages = estimatePageCount(buffer);
      const totalChunks = Math.ceil(totalPages / CHUNK_SIZE);

      // OCR first chunk
      const chunks = await splitPDF(buffer, CHUNK_SIZE);
      const ocrResult = await extractTextFromDocument(chunks[0], "application/pdf");
      await recordProcessingUsage(Math.min(CHUNK_SIZE, totalPages));

      const nextStep = totalChunks > 1 ? "ocr_chunk_1" : "classifying";

      await supabase.from("documents").update({
        processing_step: nextStep,
        processing_total_pages: totalPages,
        processing_completed_pages: Math.min(CHUNK_SIZE, totalPages),
        processing_ocr_text: ocrResult.text,
      }).eq("id", documentId);

      return NextResponse.json({ step: nextStep, totalPages, completedPages: Math.min(CHUNK_SIZE, totalPages), continue: true });
    }

    // ── STEP: OCR_CHUNK_N — OCR the Nth chunk ─────────────────────────────
    const chunkMatch = step.match(/^ocr_chunk_(\d+)$/);
    if (chunkMatch) {
      const chunkIndex = parseInt(chunkMatch[1], 10);

      // Concurrency guard
      const { data: claimed } = await supabase
        .from("documents")
        .update({ processing_step: `working_ocr_chunk_${chunkIndex}` })
        .eq("id", documentId)
        .eq("processing_step", step)
        .select("id");

      if (!claimed || claimed.length === 0) {
        return NextResponse.json({ skip: true, reason: "Already being processed" });
      }

      // Download and split
      const { data: fileData } = await supabase.storage.from("documents").download(doc.storage_path);
      if (!fileData) {
        await supabase.from("documents").update({ status: "error", processing_error: "Download failed" }).eq("id", documentId);
        return NextResponse.json({ error: "Download failed" }, { status: 500 });
      }

      const buffer = Buffer.from(await fileData.arrayBuffer());
      const chunks = await splitPDF(buffer, CHUNK_SIZE);

      if (chunkIndex >= chunks.length) {
        await supabase.from("documents").update({ processing_step: "classifying" }).eq("id", documentId);
        return NextResponse.json({ step: "classifying", continue: true });
      }

      // OCR this chunk
      const ocrResult = await extractTextFromDocument(chunks[chunkIndex], "application/pdf");
      const pagesInChunk = Math.min(CHUNK_SIZE, (doc.processing_total_pages || 0) - chunkIndex * CHUNK_SIZE);
      await recordProcessingUsage(pagesInChunk);

      const completedPages = (chunkIndex + 1) * CHUNK_SIZE;
      const isLastChunk = chunkIndex + 1 >= chunks.length;
      const nextStep = isLastChunk ? "classifying" : `ocr_chunk_${chunkIndex + 1}`;

      // Append OCR text
      await supabase.from("documents").update({
        processing_step: nextStep,
        processing_completed_pages: Math.min(completedPages, doc.processing_total_pages || completedPages),
        processing_ocr_text: (doc.processing_ocr_text || "") + ocrResult.text,
      }).eq("id", documentId);

      return NextResponse.json({ step: nextStep, completedPages, continue: true });
    }

    // ── STEP: CLASSIFYING — run classifier on full text ───────────────────
    if (step === "classifying") {
      const { data: claimed } = await supabase
        .from("documents")
        .update({ processing_step: "working_classifying" })
        .eq("id", documentId)
        .eq("processing_step", "classifying")
        .select("id");

      if (!claimed || claimed.length === 0) {
        return NextResponse.json({ skip: true, reason: "Already being processed" });
      }

      const ocrText = doc.processing_ocr_text || "";
      const classification = classifyDocument({
        text: ocrText,
        fileName: doc.file_name,
        userSelectedType: doc.doc_type,
      });

      await supabase.from("documents").update({
        processing_step: "parsing",
        classified_type: classification.classifiedType,
        classification_confidence: classification.confidence,
        classification_signals: classification.signals,
        type_mismatch: classification.mismatch,
      }).eq("id", documentId);

      return NextResponse.json({ step: "parsing", classification: classification.classifiedType, continue: true });
    }

    // ── STEP: PARSING — parse plan data and write to DB ───────────────────
    if (step === "parsing") {
      const { data: claimed } = await supabase
        .from("documents")
        .update({ processing_step: "working_parsing" })
        .eq("id", documentId)
        .eq("processing_step", "parsing")
        .select("id");

      if (!claimed || claimed.length === 0) {
        return NextResponse.json({ skip: true, reason: "Already being processed" });
      }

      const ocrText = doc.processing_ocr_text || "";
      const classification = {
        classifiedType: doc.classified_type || doc.doc_type,
        confidence: doc.classification_confidence || 0,
        mismatch: doc.type_mismatch || false,
      };

      const result = await processPlanDocumentData(
        supabase,
        { id: doc.id, user_id: doc.user_id, file_name: doc.file_name },
        ocrText,
        documentId,
        classification
      );

      if (!result.success) {
        return NextResponse.json({ error: result.error }, { status: 500 });
      }

      return NextResponse.json({ step: "done", continue: false, ...result });
    }

    // Working state — a step is in progress, check if it's stale
    if (step.startsWith("working_")) {
      const startedAt = doc.processing_started_at ? new Date(doc.processing_started_at).getTime() : 0;
      const staleMins = (Date.now() - startedAt) / 60000;
      if (staleMins > 2) {
        // Stale working state — reset to the step it was working on
        const originalStep = step.replace("working_", "");
        await supabase.from("documents").update({
          processing_step: originalStep === "init" ? null : originalStep,
          status: originalStep === "init" ? "queued" : "processing",
        }).eq("id", documentId);
        return NextResponse.json({ recovered: true, step: originalStep });
      }
      return NextResponse.json({ skip: true, reason: `Step ${step} in progress` });
    }

    return NextResponse.json({ skip: true, reason: `Unknown step: ${step}` });

  } catch (error) {
    console.error("[process-chunk] Error:", error);
    return NextResponse.json({ error: "Processing chunk failed" }, { status: 500 });
  }
}
