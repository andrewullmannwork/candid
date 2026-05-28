/**
 * GET /api/claims/[claimId]/source-document/url
 *
 * B4.2 bonus — returns a short-lived signed URL for the source document
 * (uploaded bill PDF or image) backing this claim. Powers the
 * "View uploaded bill" icon on the /claim bill-detail header.
 *
 * Auth: Firebase Bearer token. Verifies user owns the claim AND the document.
 * 404 when the claim has no source_document_id (manually-typed claims).
 *
 * Returns:
 *   { url: string, fileName: string, expiresAt: string }
 *
 * Single-document-per-claim assumption: claims.source_document_id is the
 * primary linkage (mig 075). Multi-document claims (rare) get the primary
 * doc only; multi-doc UX deferred per B4.2 §10.
 */

import { NextRequest, NextResponse } from "next/server";

import { requireAuthenticatedUser } from "@/lib/security/require-authenticated-user";
import { createServerClient } from "@/lib/supabase/server";

const SIGNED_URL_EXPIRY_SECONDS = 3600; // 1 hour

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> },
) {
  const user = await requireAuthenticatedUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { claimId } = await params;
  const supabase = createServerClient();

  const { data: claim, error: claimErr } = await supabase
    .from("claims")
    .select("user_id, source_document_id")
    .eq("id", claimId)
    .maybeSingle();

  if (claimErr || !claim) {
    return NextResponse.json({ error: "Claim not found" }, { status: 404 });
  }
  if ((claim as { user_id: string }).user_id !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const sourceDocumentId = (claim as { source_document_id: string | null }).source_document_id;
  if (!sourceDocumentId) {
    return NextResponse.json(
      { error: "No source document on file" },
      { status: 404 },
    );
  }

  const { data: doc, error: docErr } = await supabase
    .from("documents")
    .select("user_id, storage_path, file_name")
    .eq("id", sourceDocumentId)
    .maybeSingle();

  if (docErr || !doc) {
    return NextResponse.json(
      { error: "Source document not found" },
      { status: 404 },
    );
  }
  // Defense in depth — confirm document ownership matches the claim owner.
  if ((doc as { user_id: string }).user_id !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const storagePath = (doc as { storage_path: string }).storage_path;
  const fileName = (doc as { file_name: string }).file_name;

  const { data: signed, error: signedErr } = await supabase.storage
    .from("documents")
    .createSignedUrl(storagePath, SIGNED_URL_EXPIRY_SECONDS);

  if (signedErr || !signed?.signedUrl) {
    return NextResponse.json(
      { error: "Failed to generate signed URL" },
      { status: 500 },
    );
  }

  const expiresAt = new Date(Date.now() + SIGNED_URL_EXPIRY_SECONDS * 1000).toISOString();

  return NextResponse.json({
    url: signed.signedUrl,
    fileName,
    expiresAt,
  });
}
