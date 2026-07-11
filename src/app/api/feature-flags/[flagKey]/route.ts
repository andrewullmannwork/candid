/**
 * GET /api/feature-flags/[flagKey] — Read-only check for whether a product
 * flag is enabled. Unauthenticated — flag state is not user-specific at this
 * layer (user-specific targeting is handled server-side by isFeatureEnabled).
 *
 * Returns: { enabled: boolean }
 */

import { NextRequest, NextResponse } from "next/server";
import { isFeatureEnabled } from "@/lib/config/product-flags";

// Whitelist the flags exposed via this endpoint so we don't accidentally
// leak operational flags to the browser. Add keys here as new embedded UI
// features ship.
const EXPOSED_FLAGS = new Set([
  "embedded_subscribe",
  "dispute_tracking",
  "dispute_feedback_loop",
  "plan_year_rollover",
  "benefit_corrections",
  "compare_v2_redesign", // S157 Compare v2 results reskin (frontend UI gate)
  "change_plan_v1", // S207 Stretch 1 — Change plan control on /plan
  "case_file_enriched_v1", // S207 Stretch 2 — enriched Case File download on /disputes
  "dispute_plan_pinning_v1", // S210 Mid-year plan change × disputes — plan pinning (P0)
  "dispute_letters_free_start_v1", // 2026-07 dispute-letters free-to-start FE alignment gate
]);

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ flagKey: string }> }
) {
  const { flagKey } = await params;
  if (!EXPOSED_FLAGS.has(flagKey)) {
    return NextResponse.json({ enabled: false }, { status: 404 });
  }
  try {
    const enabled = await isFeatureEnabled(flagKey);
    return NextResponse.json({ enabled });
  } catch {
    return NextResponse.json({ enabled: false });
  }
}
