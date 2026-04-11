/**
 * POST /api/disputes/outcome — Update dispute outcome (status, amount recovered)
 * GET  /api/disputes/outcome?userId=<userId> — Fetch user's dispute history
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { updateDisputeOutcome, getUserDisputes } from "@/lib/disputes/persist";

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId");
  if (!userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  const supabase = createServerClient();
  const result = await getUserDisputes(supabase, userId);
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  try {
    const { disputeId, status, amountRecovered, resolutionDate, strategyNotes } = await req.json();

    if (!disputeId || !status) {
      return NextResponse.json(
        { error: "disputeId and status are required" },
        { status: 400 }
      );
    }

    const validStatuses = ["filed", "in_progress", "won", "lost", "settled", "withdrawn"];
    if (!validStatuses.includes(status)) {
      return NextResponse.json(
        { error: `status must be one of: ${validStatuses.join(", ")}` },
        { status: 400 }
      );
    }

    const supabase = createServerClient();
    const success = await updateDisputeOutcome(supabase, disputeId, {
      status,
      amountRecovered: amountRecovered ?? undefined,
      resolutionDate: resolutionDate ?? undefined,
      strategyNotes: strategyNotes ?? undefined,
    });

    if (!success) {
      return NextResponse.json({ error: "Failed to update dispute" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Dispute outcome update error:", error);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}
