import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import type { CareDataStatus } from "@/lib/care/types";

const DEFAULT_STATUS: CareDataStatus = {
  totalDataPoints: 0,
  userBillPoints: 0,
  publicDataPoints: 0,
  regionsWithData: 0,
  uniqueProcedures: 0,
  isLive: false,
};

// GET /api/care/lookup — Returns Candid Care data status
// When Candid Care is live, this will also handle pricing lookups
export async function GET() {
  try {
    const supabase = createServerClient();

    // Count total data points
    const { count: totalCount } = await supabase
      .from("pricing_data")
      .select("*", { count: "exact", head: true });

    // If table doesn't exist or is empty, return defaults
    if (totalCount === null || totalCount === 0) {
      return NextResponse.json(DEFAULT_STATUS);
    }

    // Count user bill data points
    const { count: userCount } = await supabase
      .from("pricing_data")
      .select("*", { count: "exact", head: true })
      .eq("data_source", "user_bill");

    const status: CareDataStatus = {
      totalDataPoints: totalCount,
      userBillPoints: userCount || 0,
      publicDataPoints: totalCount - (userCount || 0),
      regionsWithData: 0, // Will populate from aggregates when available
      uniqueProcedures: 0,
      isLive: false,
    };

    return NextResponse.json(status);
  } catch {
    // Graceful fallback if pricing tables don't exist yet
    return NextResponse.json(DEFAULT_STATUS);
  }
}
