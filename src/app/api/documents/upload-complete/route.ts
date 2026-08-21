/**
 * POST /api/documents/upload-complete — direct-to-storage door, phase 2 (S322).
 *
 * The client has PUT the bytes to the signed path minted by upload-start.
 * This route locates the object under the CALLER'S OWN prefix (ownership is
 * structural — the path starts with their users PK, so no other user's
 * object is reachable), downloads it, re-verifies the ACTUAL byte size
 * against the live flag limit (a lying client's declared size buys nothing),
 * and hands the bytes to the same shared ingest pipeline as the legacy door.
 * The response shape is identical to the legacy door's, so every downstream
 * client behavior (status polling, dedup handling, doc-type confirmation,
 * async-tier splash) works unchanged.
 *
 * No Turnstile here: the human check ran at upload-start; re-challenging
 * between the PUT and the finalize is exactly the per-step friction #305
 * removed. Retries are safe — a duplicate completion returns the existing
 * row's state (PK-conflict branch in the shared ingest).
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { getFlags } from "@/lib/config/feature-flags";
import {
  runUploadPreflight,
  ingestDocumentBytes,
} from "@/lib/documents/ingest-upload";
import { uploadSizeErrorMessage } from "@/lib/upload/upload-policy";

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function contentTypeForExt(ext: string): string {
  switch (ext) {
    case "pdf":
      return "application/pdf";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "heic":
    case "heif":
      return "image/heic";
    default:
      return "application/octet-stream";
  }
}

export async function POST(req: NextRequest) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();

  let body: { documentId?: string; fileName?: string; docType?: string; purpose?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const documentId = typeof body.documentId === "string" ? body.documentId : "";
  if (!UUID_RE.test(documentId)) {
    return NextResponse.json({ error: "documentId required" }, { status: 400 });
  }
  // Display metadata echoed from upload-start — same client-declared trust
  // level as the legacy door's file.name / docType form fields.
  const fileName = typeof body.fileName === "string" && body.fileName ? body.fileName : "document.pdf";
  const docType = (typeof body.docType === "string" && body.docType) || "eob";
  const rawPurpose = (typeof body.purpose === "string" && body.purpose) || "primary";
  const purpose: "primary" | "comparison" = rawPurpose === "comparison" ? "comparison" : "primary";

  const preflight = await runUploadPreflight({
    supabase,
    req,
    decoded,
    turnstileToken: undefined,
    requireTurnstile: false,
  });
  if (!preflight.ok) return preflight.response;
  const userId = preflight.ctx.user.id;

  // Locate the object under the caller's own prefix. The path was minted by
  // upload-start as `${userId}/${documentId}.${ext}` — recover the ext by
  // listing with search (a foreign documentId can never resolve here because
  // the prefix is the caller's).
  const { data: objects, error: listErr } = await supabase.storage
    .from("documents")
    .list(userId, { limit: 10, search: documentId });
  if (listErr) {
    console.error("[upload-complete] storage list failed:", listErr.message);
    return NextResponse.json({ error: "Failed to locate the upload. Please try again." }, { status: 500 });
  }
  const objectName = (objects ?? []).find((o) => o.name.startsWith(`${documentId}.`))?.name;
  if (!objectName) {
    return NextResponse.json(
      { error: "Upload not found — the file may not have finished uploading. Please try again." },
      { status: 404 },
    );
  }
  const existingObjectPath = `${userId}/${objectName}`;
  const ext = objectName.split(".").pop()?.toLowerCase() || "pdf";

  const { data: blob, error: dlErr } = await supabase.storage
    .from("documents")
    .download(existingObjectPath);
  if (dlErr || !blob) {
    console.error("[upload-complete] download failed:", dlErr?.message);
    return NextResponse.json({ error: "Failed to read the upload. Please try again." }, { status: 500 });
  }
  const buffer = Buffer.from(await blob.arrayBuffer());

  // The ACTUAL size is authoritative — the declared size at start is only a
  // fast-fail. Over-limit bytes are removed so they never linger in storage.
  const { UPLOAD_MAX_FILE_SIZE } = await getFlags();
  if (buffer.length > UPLOAD_MAX_FILE_SIZE) {
    const { error: rmErr } = await supabase.storage.from("documents").remove([existingObjectPath]);
    if (rmErr) console.warn("[upload-complete] over-limit object remove failed:", rmErr.message);
    return NextResponse.json(
      { error: uploadSizeErrorMessage(UPLOAD_MAX_FILE_SIZE) },
      { status: 400 },
    );
  }

  return ingestDocumentBytes({
    supabase,
    req,
    ctx: preflight.ctx,
    buffer,
    fileName,
    originalSize: buffer.length,
    contentType: contentTypeForExt(ext),
    ext,
    isHeicInput: ext === "heic" || ext === "heif",
    docType,
    purpose,
    documentId,
    existingObjectPath,
  });
}
