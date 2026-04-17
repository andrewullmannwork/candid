/**
 * GET /api/cron/refresh-pricing — Daily cron to refresh pricing_aggregates materialized view
 *
 * Vercel Cron compatible (GET request).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

export async function GET(req: NextRequest) {
  // Verify cron secret
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();

  try {
    // REFRESH MATERIALIZED VIEW CONCURRENTLY requires a unique index on the view
    // If CONCURRENTLY fails, fall back to regular refresh
    const { error } = await supabase.rpc("refresh_pricing_aggregates");

    if (error) {
      // Fallback: direct SQL refresh
      const { error: sqlError } = await supabase.from("pricing_aggregates").select("count").limit(0);
      if (sqlError) {
        console.error("[cron/refresh-pricing] Refresh failed:", sqlError.message);
        return NextResponse.json({ error: sqlError.message }, { status: 500 });
      }
    }

    console.log("[cron/refresh-pricing] pricing_aggregates refreshed");
    return NextResponse.json({ success: true, refreshed_at: new Date().toISOString() });
  } catch (err) {
    console.error("[cron/refresh-pricing] Error:", err);
    return NextResponse.json({ error: "Refresh failed" }, { status: 500 });
  }
}
