/**
 * GET /api/feature-flags/profile-dashboard
 *
 * Returns the current state of the `profile_dashboard_v1` rollout flag for the
 * /profile dashboard view (S121 B2.1). Distinct from the generic
 * /api/feature-flags/[flagKey] endpoint because this flag uses "default ON when
 * row missing" semantics per Andrew direction at S121.
 *
 * Unauthenticated read — response is a single boolean and contains no
 * user-specific data.
 */
import { NextResponse } from "next/server";
import { isProfileDashboardEnabled } from "@/lib/config/profile-dashboard-flag";

export async function GET() {
  const enabled = await isProfileDashboardEnabled();
  return NextResponse.json({ enabled });
}
