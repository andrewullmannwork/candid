// POST /api/documents/process
// Legacy single-pass processor (the primary upload path is /upload → QStash →
// /api/documents/process-chunk). Triggers OCR + classification, then either
// parses plan data (SBC/plan_document) or runs the bill/EOB audit pipeline.
//
// AUTH (B9-F01 + B1): mandatory Firebase bearer token + document ownership
// enforced by a userScoped() read (a foreign/unknown id → 404, no 403 oracle).
// The processing core lives in @/lib/documents/process-document and is shared
// with the admin route. The previous forgeable `x-internal` and
// `x-admin-override` header bypasses have been removed.

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/security/require-authenticated-user";
import { userScoped } from "@/lib/security/user-scoped";
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

    // B1 / B9-F01 — fetch the document SCOPED to the authed user. userScoped
    // injects `.eq("user_id")`, so a foreign or unknown id returns null → 404
    // (one indistinguishable response; no 403 existence oracle). This replaces
    // the prior fetch-by-id + separate unconditional 403 ownership branch.
    const { data: doc, error: docError } = await userScoped(supabase, authedUser.id)
      .table("documents")
      .select("*")
      .eq("id", documentId)
      .maybeSingle();

    if (docError || !doc) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
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
