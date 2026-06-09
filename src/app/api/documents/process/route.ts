// POST /api/documents/process
// Legacy single-pass processor (the primary upload path is /upload → QStash →
// /api/documents/process-chunk). Triggers OCR + classification, then either
// parses plan data (SBC/plan_document) or runs the bill/EOB audit pipeline.
//
// AUTH (B9-F01): mandatory Firebase bearer token + unconditional document
// ownership. The processing core lives in @/lib/documents/process-document and
// is shared with the admin route. The previous forgeable `x-internal` and
// `x-admin-override` header bypasses have been removed.

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/security/require-authenticated-user";
import { processDocument } from "@/lib/documents/process-document";
import type { DocumentRow } from "@/lib/supabase/types";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    // Mandatory authentication — no anonymous or `x-internal` bypass.
    const authedUser = await requireAuthenticatedUser(req);
    if (!authedUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

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

    // Verify document exists and is owned by the authenticated user.
    const { data: doc, error: docError } = await supabase
      .from("documents")
      .select("*")
      .eq("id", documentId)
      .single();

    if (docError || !doc) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    // Ownership is enforced UNCONDITIONALLY (B9-F01): the prior check was a
    // no-op whenever the request was unauthenticated.
    if (doc.user_id !== authedUser.id) {
      return NextResponse.json({ error: "Not authorized for this document" }, { status: 403 });
    }

    const result = await processDocument(supabase, {
      doc: doc as DocumentRow,
      billType,
      adminOverride: false,
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error("Document processing error:", error);
    return NextResponse.json(
      { error: "Processing failed. Please try again." },
      { status: 500 }
    );
  }
}
