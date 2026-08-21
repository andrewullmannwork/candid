/**
 * S322 — upload policy (pure, shared by server routes, client surfaces, fixture).
 *
 * ONE derivation for what a document upload may be (type + size) and what the
 * user is told when it may not. Before S322 the size ceiling lived in six
 * places (server env-only flag read + five hardcoded client checks at 20MB or
 * 25MB) and none of them read the admin-tuned value — the exact drift class
 * this module retires.
 *
 * The platform fact this module encodes: request bodies through Vercel
 * serverless functions are capped at ~4.5MB (probed live: 9MB and 29MB POSTs
 * die at the edge with FUNCTION_PAYLOAD_TOO_LARGE before route code runs).
 * Files above that ceiling can only arrive via the direct-to-storage path
 * (signed upload URL), gated by DIRECT_UPLOAD_ENABLED. When the direct path
 * is OFF, the honest client ceiling is the platform's, not the flag's.
 */

/** Client-visible upload limits, served by GET /api/upload-limits. */
export interface UploadLimits {
  maxFileSizeBytes: number;
  directUploadEnabled: boolean;
}

/**
 * Safe margin under Vercel's ~4.5MB serverless request-body cap (the cap
 * counts multipart overhead too). Legacy body-POST uploads above this die at
 * the platform edge with an opaque 413, so the client must not offer them.
 */
export const LEGACY_SAFE_MAX_BYTES = 4 * 1024 * 1024;

/** Conservative fallback when /api/upload-limits is unreachable. */
export const FALLBACK_UPLOAD_LIMITS: UploadLimits = {
  maxFileSizeBytes: LEGACY_SAFE_MAX_BYTES,
  directUploadEnabled: false,
};

/** Mirrors the server's accepted formats (upload route allowedTypes). */
export const ALLOWED_UPLOAD_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
] as const;

export function isHeicName(name: string): boolean {
  return /\.(heic|heif)$/i.test(name);
}

/** Type gate — same rule every surface and the server apply. */
export function isAllowedUploadFile(name: string, mime: string): boolean {
  return (
    (ALLOWED_UPLOAD_MIME_TYPES as readonly string[]).includes(mime) ||
    isHeicName(name)
  );
}

export const UPLOAD_TYPE_ERROR_MESSAGE =
  "Accepted formats: PDF, JPEG, PNG, or HEIC (iPhone photos).";

/** The user-facing size message, derived from the live limit — never hardcode. */
export function uploadSizeErrorMessage(maxBytes: number): string {
  return `File must be under ${Math.round(maxBytes / 1024 / 1024)}MB.`;
}

/**
 * The ceiling the CLIENT may honestly offer: the admin-tuned limit when the
 * direct-to-storage path is live, else the platform-safe legacy ceiling
 * (whichever is lower). The server's own checks always use the flag value.
 */
export function effectiveClientMaxBytes(limits: UploadLimits): number {
  return limits.directUploadEnabled
    ? limits.maxFileSizeBytes
    : Math.min(limits.maxFileSizeBytes, LEGACY_SAFE_MAX_BYTES);
}

/**
 * Pick-time validation for every upload surface. Returns the user-facing
 * error string, or null when the file is acceptable.
 */
export function validateUploadFile(
  file: { name: string; type: string; size: number },
  limits: UploadLimits,
): string | null {
  if (!isAllowedUploadFile(file.name, file.type)) {
    return UPLOAD_TYPE_ERROR_MESSAGE;
  }
  const maxBytes = effectiveClientMaxBytes(limits);
  if (file.size > maxBytes) {
    return uploadSizeErrorMessage(maxBytes);
  }
  return null;
}
