/**
 * POST /api/documents/upload — the LEGACY body-POST door.
 *
 * S322: the pipeline itself lives in src/lib/documents/ingest-upload.ts
 * (verbatim extraction) and is shared with the direct-to-storage doors
 * (upload-start + upload-complete). This route is now a thin adapter: parse
 * the multipart form, run the shared preflight/caps, hand the bytes to the
 * shared ingest. Behavior is byte-identical to the pre-S322 route for every
 * file this door can physically receive.
 *
 * ⚠ Platform ceiling: Vercel serverless rejects request bodies over ~4.5MB
 * at the edge (413 FUNCTION_PAYLOAD_TOO_LARGE — probed live at S322) before
 * this code runs. Larger files arrive via the direct-to-storage path only.
 * This door stays for stale client bundles and the DIRECT_UPLOAD_ENABLED=off
 * fallback.
 *
 * The size check reads the DB-backed flag (getFlags) — pre-S322 it read the
 * env-only static FLAGS object, which silently ignored /admin/settings.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { getFlags } from "@/lib/config/feature-flags";
import {
  runUploadPreflight,
  enforceUploadCapsAndSweeps,
  ingestDocumentBytes,
} from "@/lib/documents/ingest-upload";
import {
  isAllowedUploadFile,
  isHeicName,
  UPLOAD_TYPE_ERROR_MESSAGE,
  uploadSizeErrorMessage,
} from "@/lib/upload/upload-policy";

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();

  // Parse form data
  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  // S91: docType is the user's pick from the upload form. May be overridden
  // by the doc-type resolver after quick-classify (Rule 1: high-conf classifier
  // disagreement; Rule 2: SBC with pages > sbc_max_pages safety net). The
  // initial documents INSERT uses the user pick; the override block
  // re-UPDATEs doc_type + writes classification_override to metadata if either
  // rule fires. See src/lib/documents/effective-doc-type.ts.
  const docType = (formData.get("docType") as string) || "eob";
  const turnstileToken = (formData.get("turnstileToken") as string) || undefined;
  // purpose (mig 078): "primary" (default; replaces user's active plan) vs
  // "comparison" (via /compare; persists for flywheel but does NOT touch the
  // user's active plan). Validate the input so an attacker can't smuggle
  // arbitrary values into a CHECK-constrained column.
  const rawPurpose = (formData.get("purpose") as string) || "primary";
  const purpose: "primary" | "comparison" = rawPurpose === "comparison" ? "comparison" : "primary";

  const preflight = await runUploadPreflight({
    supabase,
    req,
    decoded,
    turnstileToken,
    requireTurnstile: true,
  });
  if (!preflight.ok) return preflight.response;

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  // Validate file
  if (!isAllowedUploadFile(file.name, file.type)) {
    return NextResponse.json({ error: UPLOAD_TYPE_ERROR_MESSAGE }, { status: 400 });
  }
  const { UPLOAD_MAX_FILE_SIZE } = await getFlags();
  if (file.size > UPLOAD_MAX_FILE_SIZE) {
    return NextResponse.json({ error: uploadSizeErrorMessage(UPLOAD_MAX_FILE_SIZE) }, { status: 400 });
  }

  const capResponse = await enforceUploadCapsAndSweeps(supabase, preflight.ctx);
  if (capResponse) return capResponse;

  const documentId = crypto.randomUUID();
  const isHeic = isHeicName(file.name);
  const ext = file.name.split(".").pop()?.toLowerCase() || "pdf";
  const contentType = file.type || (isHeic ? "image/heic" : "application/octet-stream");
  const buffer = Buffer.from(await file.arrayBuffer());

  return ingestDocumentBytes({
    supabase,
    req,
    ctx: preflight.ctx,
    buffer,
    fileName: file.name,
    originalSize: file.size,
    contentType,
    ext,
    isHeicInput: isHeic,
    docType,
    purpose,
    documentId,
  });
}
