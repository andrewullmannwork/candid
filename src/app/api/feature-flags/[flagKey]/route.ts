/**
 * GET /api/feature-flags/[flagKey] — Read-only check for whether a product
 * flag is enabled. Unauthenticated — flag state is not user-specific at this
 * layer (user-specific targeting is handled server-side by isFeatureEnabled).
 *
 * Returns: { enabled: boolean } for an allowlisted key.
 *          { error: "flag_not_exposed" } + 404 for anything else.
 *
 * The allowlist itself lives in @/lib/config/exposed-flags so `useFeatureFlag`
 * can derive its parameter type from the same constant this route enforces.
 */

import { NextRequest, NextResponse } from "next/server";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import { getFlags } from "@/lib/config/feature-flags";
import { EXPOSED_FLAG_SET, EXPOSED_KV_FLAG_SET } from "@/lib/config/exposed-flags";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ flagKey: string }> }
) {
  const { flagKey } = await params;
  if (EXPOSED_KV_FLAG_SET.has(flagKey)) {
    try {
      const kv = await getFlags();
      return NextResponse.json({ enabled: kv.TEST_PHONE_EXEMPTION_ENABLED });
    } catch {
      return NextResponse.json({ enabled: false });
    }
  }
  if (!EXPOSED_FLAG_SET.has(flagKey)) {
    // Deliberately NOT `{ enabled: false }`. That body is a valid-looking
    // answer, so an operational check (`curl .../api/feature-flags/<key>`)
    // reads "the flag is off" when the truth is "this endpoint cannot tell
    // you" — which is exactly how S313 misread PROD's flag state before the
    // promote. Clients are unaffected: every one either gates on `res.ok` or
    // tests `enabled === true` / `!!enabled`, and `undefined` is falsy.
    return NextResponse.json({ error: "flag_not_exposed" }, { status: 404 });
  }
  try {
    const enabled = await isFeatureEnabled(flagKey);
    return NextResponse.json({ enabled });
  } catch {
    return NextResponse.json({ enabled: false });
  }
}
