/**
 * GET   /api/admin/flags — list every row in the feature_flags table.
 * PATCH /api/admin/flags — set a flag's value, then clear the in-memory flag
 *   cache so the change takes effect immediately (no redeploy).
 *
 * Backs the /admin/flags console. Note the two-system gotcha: feature_flags is
 * the key/value store (env → DB → default resolution, incl. int/config knobs);
 * the boolean rule engine lives in feature_flag_rules (a separate surface).
 * Writes stamp updated_by with the admin's users PK for the audit trail.
 *
 * Auth: requireAdmin (Firebase bearer token + users.is_admin).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin/require-admin";
import { clearFlagCache } from "@/lib/config/feature-flags";

/** GET: Return all feature flags */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("feature_flags")
    .select("*")
    .order("key");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ flags: data });
}

/** PATCH: Update a feature flag */
export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { key, value } = await req.json();

  if (!key || value === undefined) {
    return NextResponse.json({ error: "key and value required" }, { status: 400 });
  }

  const supabase = createServerClient();
  const { error } = await supabase
    .from("feature_flags")
    .update({
      value: String(value),
      updated_at: new Date().toISOString(),
      updated_by: auth.adminUserId,
    })
    .eq("key", key);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Clear the in-memory cache so changes take effect immediately
  clearFlagCache();

  return NextResponse.json({ success: true });
}
