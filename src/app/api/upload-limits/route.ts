/**
 * GET /api/upload-limits — the client's ONE source for upload limits (S322).
 *
 * Serves the admin-tuned key/value flags (getFlags: env → DB → default) to
 * every upload surface, replacing five hardcoded client ceilings (20MB ×3,
 * 25MB ×2) that silently ignored /admin/settings. Public and unauthenticated:
 * a numeric limit and a transport toggle are not sensitive, and the /check
 * anonymous funnel needs them pre-auth. Values change within 60s of an admin
 * edit (flag cache TTL); the client falls back to the conservative
 * FALLBACK_UPLOAD_LIMITS when this endpoint is unreachable.
 */

import { NextResponse } from "next/server";
import { getFlags } from "@/lib/config/feature-flags";
import type { UploadLimits } from "@/lib/upload/upload-policy";

export async function GET() {
  const flags = await getFlags();
  const limits: UploadLimits = {
    maxFileSizeBytes: flags.UPLOAD_MAX_FILE_SIZE,
    directUploadEnabled: flags.DIRECT_UPLOAD_ENABLED,
  };
  return NextResponse.json(limits);
}
