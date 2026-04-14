/**
 * POST /api/documents/reprocess
 *
 * User-triggered document reprocessing. Handles two failure modes:
 *   1. Explicit error (status="error") — document failed during processing
 *   2. Stuck processing (status="processing", no progress for >10 min)
 *
 * Smart resume: if OCR text was already extracted, skips to classification.
 * Otherwise restarts from scratch. Max 3 user-triggered retries.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { enqueueChunk } from "@/lib/queue/qstash";

const MAX_RETRIES = 3;
const STUCK_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

export async function POST(req: NextRequest) {
  try {
    // Auth: verify user
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let decoded;
    try {
      decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    } catch {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    const { documentId } = await req.json();
    if (!documentId) {
      return NextResponse.json({ error: "documentId required" }, { status: 400 });
    }

    const supabase = createServerClient();

    // Look up internal user ID
    const { data: user } = await supabase
      .from("users")
      .select("id")
      .eq("firebase_uid", decoded.uid)
      .single();

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Fetch document and verify ownership
    const { data: doc, error: docError } = await supabase
      .from("documents")
      .select("id, user_id, status, processing_step, processing_started_at, processing_ocr_text, processing_completed_pages, processing_total_pages, retry_count")
      .eq("id", documentId)
      .single();

    if (docError || !doc) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    if (doc.user_id !== user.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    // Validate status: must be error or stuck
    const isError = doc.status === "error";
    const isStuck = doc.status === "processing"
      && doc.processing_started_at
      && (Date.now() - new Date(doc.processing_started_at).getTime()) > STUCK_THRESHOLD_MS;

    if (!isError && !isStuck) {
      return NextResponse.json(
        { error: "Document is not in a retryable state" },
        { status: 400 }
      );
    }

    // Check retry limit
    const retryCount = doc.retry_count || 0;
    if (retryCount >= MAX_RETRIES) {
      return NextResponse.json(
        { error: "Maximum retries reached. Please contact support." },
        { status: 429 }
      );
    }

    // Smart resume: if OCR text exists, skip to classification
    const hasOcrText = !!doc.processing_ocr_text && doc.processing_ocr_text.length > 100;
    let resumeFrom: "classifying" | "init";

    if (hasOcrText) {
      // OCR completed — resume from classification
      resumeFrom = "classifying";
      await supabase.from("documents").update({
        status: "processing",
        processing_step: "classifying",
        processing_error: null,
        retry_count: retryCount + 1,
        processing_started_at: new Date().toISOString(),
      }).eq("id", documentId);
    } else {
      // OCR never completed — full restart
      resumeFrom = "init";
      await supabase.from("documents").update({
        status: "queued",
        processing_step: null,
        processing_error: null,
        processing_ocr_text: null,
        processing_completed_pages: 0,
        retry_count: retryCount + 1,
        processing_started_at: null,
      }).eq("id", documentId);
    }

    // Enqueue for processing
    const baseUrl = new URL(req.url).origin;
    await enqueueChunk(documentId, baseUrl);

    return NextResponse.json({
      success: true,
      resumeFrom,
      retryCount: retryCount + 1,
    });
  } catch (error) {
    console.error("[reprocess] Error:", error);
    return NextResponse.json({ error: "Reprocess failed" }, { status: 500 });
  }
}
