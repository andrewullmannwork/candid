/**
 * POST /api/documents/upload-start — direct-to-storage door, phase 1 (S322).
 *
 * Why this exists: Vercel serverless rejects request bodies over ~4.5MB at
 * the edge (probed live: 9MB/29MB POSTs → 413 FUNCTION_PAYLOAD_TOO_LARGE
 * before route code runs), so the admin-tuned UPLOAD_MAX_FILE_SIZE could
 * never actually be honored by the legacy body-POST door. Here the bytes
 * never transit Vercel: this route runs every pre-byte gate (preflight,
 * Turnstile, caps) against the DECLARED file metadata, then issues a Supabase
 * Storage signed upload URL bound to a server-minted path. The client PUTs
 * the bytes straight to storage and calls upload-complete, which re-verifies
 * the ACTUAL byte size and runs the same shared ingest pipeline as the
 * legacy door.
 *
 * Gated by DIRECT_UPLOAD_ENABLED (feature_flags key/value; env override
 * wins). OFF → 409 direct_upload_disabled; the client helper falls back to
 * the legacy door.
 *
 * Orphan hygiene: a client that gets a signed URL and never completes leaves
 * an object with no documents row. Each start sweeps the caller's OWN storage
 * prefix for row-less objects older than 1h — lazy, per-user-bounded,
 * fail-soft — so abandoned PUTs never accumulate.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { getFlags } from "@/lib/config/feature-flags";
import {
  runUploadPreflight,
  enforceUploadCapsAndSweeps,
} from "@/lib/documents/ingest-upload";
import {
  isAllowedUploadFile,
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

const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000; // 1h — a live PUT never lingers this long

async function sweepOrphanObjects(
  supabase: ReturnType<typeof createServerClient>,
  userId: string,
): Promise<void> {
  try {
    const { data: objects, error } = await supabase.storage
      .from("documents")
      .list(userId, { limit: 100 });
    if (error || !objects?.length) return;

    const candidates = objects.filter((o) => {
      const created = o.created_at ? Date.parse(o.created_at) : NaN;
      return Number.isFinite(created) && Date.now() - created > ORPHAN_MIN_AGE_MS;
    });
    if (!candidates.length) return;

    const idsByName = new Map<string, string>();
    for (const o of candidates) {
      const docId = o.name.split(".")[0];
      // Storage names are `${documentId}.${ext}` — anything else is not ours to touch.
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(docId)) {
        idsByName.set(o.name, docId);
      }
    }
    if (!idsByName.size) return;

    const { data: rows, error: rowsErr } = await supabase
      .from("documents")
      .select("id")
      .in("id", [...new Set(idsByName.values())]);
    if (rowsErr) return; // fail-soft: never delete when the row check itself failed
    const known = new Set((rows ?? []).map((r) => r.id as string));

    const orphans = [...idsByName.entries()]
      .filter(([, docId]) => !known.has(docId))
      .map(([name]) => `${userId}/${name}`);
    if (!orphans.length) return;

    const { error: rmErr } = await supabase.storage.from("documents").remove(orphans);
    if (rmErr) console.warn("[upload-start] orphan sweep remove failed:", rmErr.message);
    else console.log(`[upload-start] swept ${orphans.length} orphan object(s) for user ${userId}`);
  } catch (err) {
    console.warn("[upload-start] orphan sweep failed (non-fatal):", err);
  }
}

export async function POST(req: NextRequest) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();

  let body: {
    fileName?: string;
    fileSize?: number;
    mime?: string;
    docType?: string;
    purpose?: string;
    turnstileToken?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const fileName = typeof body.fileName === "string" ? body.fileName : "";
  const fileSize = typeof body.fileSize === "number" ? body.fileSize : NaN;
  const mime = typeof body.mime === "string" ? body.mime : "";
  if (!fileName || !Number.isFinite(fileSize) || fileSize <= 0) {
    return NextResponse.json({ error: "fileName and fileSize required" }, { status: 400 });
  }

  const preflight = await runUploadPreflight({
    supabase,
    req,
    decoded,
    turnstileToken: body.turnstileToken || undefined,
    requireTurnstile: true,
  });
  if (!preflight.ok) return preflight.response;

  const flags = await getFlags();
  if (!flags.DIRECT_UPLOAD_ENABLED) {
    return NextResponse.json(
      { error: "Direct upload is not enabled.", code: "direct_upload_disabled" },
      { status: 409 },
    );
  }

  // Same gates as the legacy door, applied to the declared metadata. The
  // ACTUAL byte size is re-verified at upload-complete; the storage bucket /
  // project cap is the hard backstop against a lying client in between.
  if (!isAllowedUploadFile(fileName, mime)) {
    return NextResponse.json({ error: UPLOAD_TYPE_ERROR_MESSAGE }, { status: 400 });
  }
  if (fileSize > flags.UPLOAD_MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: uploadSizeErrorMessage(flags.UPLOAD_MAX_FILE_SIZE) },
      { status: 400 },
    );
  }

  const capResponse = await enforceUploadCapsAndSweeps(supabase, preflight.ctx);
  if (capResponse) return capResponse;

  await sweepOrphanObjects(supabase, preflight.ctx.user.id);

  const documentId = crypto.randomUUID();
  const ext = fileName.split(".").pop()?.toLowerCase() || "pdf";
  const storagePath = `${preflight.ctx.user.id}/${documentId}.${ext}`;

  const { data: signed, error: signErr } = await supabase.storage
    .from("documents")
    .createSignedUploadUrl(storagePath);
  if (signErr || !signed) {
    console.error("[upload-start] createSignedUploadUrl failed:", signErr?.message);
    return NextResponse.json(
      { error: "Failed to prepare the upload. Please try again." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    documentId,
    storagePath,
    signedUrl: signed.signedUrl,
    token: signed.token,
  });
}
