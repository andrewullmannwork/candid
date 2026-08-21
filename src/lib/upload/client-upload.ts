/**
 * S322 — the ONE client upload path for document surfaces.
 *
 * Every upload surface (/upload, /check, onboarding doc step, /compare) calls
 * uploadDocumentFile instead of hand-rolling its own XHR — before S322 there
 * were four copies of the same FormData+XHR block and five hardcoded size
 * ceilings, none reading the admin-tuned limit.
 *
 * Transport pick (one rule, one place):
 *   - file ≤ LEGACY_SAFE_MAX_BYTES → legacy body-POST to /api/documents/upload
 *     (single request, proven path, under Vercel's ~4.5MB edge cap)
 *   - larger + direct enabled      → 3-phase direct-to-storage:
 *       POST /api/documents/upload-start   (gates + signed URL)
 *       PUT  bytes → Supabase Storage      (XHR for progress; bypasses Vercel)
 *       POST /api/documents/upload-complete (verify + shared ingest)
 *   - larger + direct disabled     → rejected client-side with the honest
 *     ceiling message (pre-S322 these died at Vercel's edge as opaque 413s)
 *
 * All phases resolve to a Response whose JSON matches the legacy door's
 * contract, so surface code downstream of the upload call is unchanged.
 */

import {
  FALLBACK_UPLOAD_LIMITS,
  LEGACY_SAFE_MAX_BYTES,
  effectiveClientMaxBytes,
  uploadSizeErrorMessage,
  type UploadLimits,
} from "@/lib/upload/upload-policy";

let limitsPromise: Promise<UploadLimits> | null = null;

/** Fetch (once per page load) the live upload limits; conservative fallback. */
export function getUploadLimits(): Promise<UploadLimits> {
  if (!limitsPromise) {
    limitsPromise = fetch("/api/upload-limits")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((json) => {
        const max = Number((json as UploadLimits).maxFileSizeBytes);
        return {
          maxFileSizeBytes: Number.isFinite(max) && max > 0 ? max : FALLBACK_UPLOAD_LIMITS.maxFileSizeBytes,
          directUploadEnabled: (json as UploadLimits).directUploadEnabled === true,
        };
      })
      .catch(() => {
        limitsPromise = null; // allow a later retry instead of caching the failure
        return FALLBACK_UPLOAD_LIMITS;
      });
  }
  return limitsPromise;
}

export interface UploadAbortHandle {
  abort: () => void;
}

export interface UploadDocumentArgs {
  file: File;
  docType: string;
  idToken: string;
  purpose?: "primary" | "comparison";
  turnstileToken?: string | null;
  onProgress?: (percent: number) => void;
  /** Surfaces that support cancel keep this ref pointed at the active phase. */
  abortRef?: { current: UploadAbortHandle | null };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function xhrSend(args: {
  method: string;
  url: string;
  body: XMLHttpRequestBodyInit;
  headers: Record<string, string>;
  onProgress?: (loaded: number, total: number) => void;
  abortRef?: { current: UploadAbortHandle | null };
}): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    if (args.abortRef) args.abortRef.current = { abort: () => xhr.abort() };
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable && args.onProgress) args.onProgress(e.loaded, e.total);
    });
    xhr.addEventListener("load", () => {
      if (args.abortRef) args.abortRef.current = null;
      resolve(
        new Response(xhr.responseText, {
          status: xhr.status,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    xhr.addEventListener("error", () => {
      if (args.abortRef) args.abortRef.current = null;
      reject(new Error("Upload failed"));
    });
    xhr.addEventListener("abort", () => {
      if (args.abortRef) args.abortRef.current = null;
      reject(new Error("Upload aborted by user"));
    });
    xhr.open(args.method, args.url);
    for (const [k, v] of Object.entries(args.headers)) xhr.setRequestHeader(k, v);
    xhr.send(args.body);
  });
}

/**
 * Upload a document through the right door. Resolves to a Response whose JSON
 * follows the legacy /api/documents/upload contract on every path; rejects
 * only on network failure or user abort (matching the legacy XHR behavior).
 */
export async function uploadDocumentFile(args: UploadDocumentArgs): Promise<Response> {
  const limits = await getUploadLimits();
  const { file } = args;

  // Honest pre-check: never send bytes a door will refuse. (Surfaces also
  // validate at pick time via validateUploadFile — this is the backstop.)
  const maxBytes = effectiveClientMaxBytes(limits);
  if (file.size > maxBytes) {
    return jsonResponse(400, { error: uploadSizeErrorMessage(maxBytes) });
  }

  const useDirect = limits.directUploadEnabled && file.size > LEGACY_SAFE_MAX_BYTES;
  if (!useDirect) {
    return legacyBodyPost(args);
  }

  // Phase 1 — gates + signed URL (small JSON; any rejection Response is
  // returned as-is so surface error handling, incl. the /check
  // turnstile_required retry, works unchanged).
  const startRes = await fetch("/api/documents/upload-start", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.idToken}`,
    },
    body: JSON.stringify({
      fileName: file.name,
      fileSize: file.size,
      mime: file.type,
      docType: args.docType,
      purpose: args.purpose ?? "primary",
      turnstileToken: args.turnstileToken ?? undefined,
    }),
  });
  if (!startRes.ok) {
    // Direct door dark (flag raced off) → fall back to the legacy door rather
    // than dead-ending; anything else surfaces to the caller unchanged.
    const peek = (await startRes.clone().json().catch(() => ({}))) as { code?: string };
    if (peek.code === "direct_upload_disabled") return legacyBodyPost(args);
    return startRes;
  }
  const start = (await startRes.json()) as { documentId: string; signedUrl: string };

  // Phase 2 — the bytes go straight to storage (never through Vercel).
  args.onProgress?.(0);
  const putRes = await xhrSend({
    method: "PUT",
    url: start.signedUrl,
    body: file,
    headers: { "Content-Type": file.type || "application/octet-stream" },
    onProgress: (loaded, total) => args.onProgress?.(Math.round((loaded / total) * 98)),
    abortRef: args.abortRef,
  });
  if (putRes.status < 200 || putRes.status >= 300) {
    return jsonResponse(502, { error: "Upload failed. Please try again." });
  }

  // Phase 3 — verify + ingest (same pipeline, same response contract).
  const completeRes = await fetch("/api/documents/upload-complete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.idToken}`,
    },
    body: JSON.stringify({
      documentId: start.documentId,
      fileName: file.name,
      docType: args.docType,
      purpose: args.purpose ?? "primary",
    }),
  });
  if (completeRes.ok) args.onProgress?.(100);
  return completeRes;
}

function legacyBodyPost(args: UploadDocumentArgs): Promise<Response> {
  const formData = new FormData();
  formData.append("file", args.file);
  formData.append("docType", args.docType);
  if (args.turnstileToken) formData.append("turnstileToken", args.turnstileToken);
  if (args.purpose === "comparison") formData.append("purpose", "comparison");
  args.onProgress?.(0);
  return xhrSend({
    method: "POST",
    url: "/api/documents/upload",
    body: formData,
    headers: { Authorization: `Bearer ${args.idToken}` },
    onProgress: (loaded, total) => args.onProgress?.(Math.round((loaded / total) * 100)),
    abortRef: args.abortRef,
  });
}
