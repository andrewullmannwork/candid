/**
 * POST /api/documents/confirm-doc-type
 *
 * S94 B5 — resolves a document parked at processing_step='awaiting_doc_type_confirmation'.
 * The upload route halts the pipeline there when the regex classifier disagrees
 * with the user's pick at moderate confidence (above confirmation_regex_threshold
 * but below the Pattern P hard-override threshold). The frontend polls for that
 * status, shows a modal, and POSTs the user's decision here.
 *
 * Body shapes:
 *   { documentId: string, action: "cancel" }
 *     — User wants to upload a different file. Marks doc cancelled; storage row
 *       remains (admin can audit) but pipeline does not resume.
 *
 *   { documentId: string, action: "confirm", confirmedDocType: <opt> }
 *     — confirmedDocType must be one of metadata.doc_type_confirmation.options
 *       (i.e., the user's original pick OR the regex classifier's pick). The
 *       document's doc_type is updated, status reset, and OCR re-enqueued.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { enqueueChunk } from "@/lib/queue/qstash";

const ALLOWED_DOC_TYPES = new Set([
  "sbc",
  "plan_document",
  "eoc",
  "itemized_bill",
  "eob",
]);

export async function POST(req: NextRequest) {
  try {
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

    const body = await req.json();
    const { documentId, action, confirmedDocType } = body as {
      documentId?: string;
      action?: "confirm" | "cancel";
      confirmedDocType?: string;
    };
    if (!documentId || !action) {
      return NextResponse.json(
        { error: "documentId and action required" },
        { status: 400 },
      );
    }
    if (action !== "confirm" && action !== "cancel") {
      return NextResponse.json(
        { error: "action must be 'confirm' or 'cancel'" },
        { status: 400 },
      );
    }

    const supabase = createServerClient();

    const { data: user } = await supabase
      .from("users")
      .select("id")
      .eq("firebase_uid", decoded.uid)
      .single();
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const { data: doc, error: docError } = await supabase
      .from("documents")
      .select("id, user_id, status, processing_step, doc_type, metadata")
      .eq("id", documentId)
      .single();
    if (docError || !doc) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }
    if (doc.user_id !== user.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }
    if (doc.processing_step !== "awaiting_doc_type_confirmation") {
      return NextResponse.json(
        { error: "Document is not awaiting doc-type confirmation" },
        { status: 400 },
      );
    }

    const metadata = (doc.metadata ?? {}) as Record<string, unknown>;
    const confirmationMeta = metadata.doc_type_confirmation as
      | { options?: string[] }
      | undefined;
    const allowedOptions = confirmationMeta?.options ?? [];

    if (action === "cancel") {
      await supabase
        .from("documents")
        .update({
          status: "cancelled",
          processing_step: "cancelled_by_user",
          metadata: {
            ...metadata,
            doc_type_confirmation_result: {
              action: "cancel",
              decided_at: new Date().toISOString(),
            },
          },
        })
        .eq("id", documentId);
      return NextResponse.json({ success: true, action: "cancel" });
    }

    // action === "confirm"
    if (!confirmedDocType || !ALLOWED_DOC_TYPES.has(confirmedDocType)) {
      return NextResponse.json(
        { error: "confirmedDocType is missing or invalid" },
        { status: 400 },
      );
    }
    if (allowedOptions.length > 0 && !allowedOptions.includes(confirmedDocType)) {
      return NextResponse.json(
        {
          error: `confirmedDocType must be one of: ${allowedOptions.join(", ")}`,
        },
        { status: 400 },
      );
    }

    await supabase
      .from("documents")
      .update({
        doc_type: confirmedDocType,
        status: "queued",
        processing_step: null,
        processing_error: null,
        metadata: {
          ...metadata,
          doc_type_confirmation_result: {
            action: "confirm",
            confirmed_doc_type: confirmedDocType,
            decided_at: new Date().toISOString(),
          },
        },
      })
      .eq("id", documentId);

    const baseUrl = new URL(req.url).origin;
    const enqueued = await enqueueChunk(documentId, baseUrl);
    if (!enqueued) {
      await supabase
        .from("documents")
        .update({
          status: "error",
          processing_error: "Failed to re-enqueue after doc-type confirmation. Please retry.",
        })
        .eq("id", documentId);
      return NextResponse.json(
        { error: "Failed to enqueue for processing" },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      action: "confirm",
      confirmedDocType,
    });
  } catch (error) {
    console.error("[confirm-doc-type] Error:", error);
    return NextResponse.json(
      { error: "Confirm-doc-type failed" },
      { status: 500 },
    );
  }
}
