/**
 * POST /api/claims/[claimId]/case-events — the case rail's ONE write (S299,
 * timeline unification phase 1a).
 *
 * Backs the "Collection resumed anyway" quiet door on a debt-validation
 * waiting card (agenda §0.9d ruling 6): v1 is CAPTURE-ONLY — the report goes
 * on the case record (`claim_case_events`, mig 221) with no downstream flow.
 * The kind whitelist is deliberately ONE entry; new rail-writable kinds are a
 * reviewed code change here, never a pass-through of client input.
 *
 * Gates: 404 unless BOTH `case_rail_v1` (the surface) AND `case_timeline_v1`
 * (the spine) are ON — the door must never silently no-op into a dead ledger
 * (the emitter itself is fail-soft and flag-gated; without this check a
 * rail-ON/spine-OFF misconfiguration would return 200 and write nothing).
 *
 * Auth: Firebase bearer → users PK; claim ownership + dispute-belongs-to-claim
 * verified via userScoped (B9) before the emit. Duplicate clicks are tolerated
 * (append-only ledger; the client disables the door after success).
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import { emitCaseEvent, type CaseEventKind } from "@/lib/case/case-events";

const RAIL_WRITABLE_KINDS: readonly CaseEventKind[] = ["collection_resumed_reported"];

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> },
) {
  try {
    const decoded = await getAuthUser(req);
    if (!decoded) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (
      !(await isFeatureEnabled("case_rail_v1")) ||
      !(await isFeatureEnabled("case_timeline_v1"))
    ) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const { claimId } = await params;
    const supabase = createServerClient();

    const { data: user } = await supabase
      .from("users")
      .select("id")
      .eq("firebase_uid", decoded.uid)
      .single();
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const body = (await req.json().catch(() => null)) as {
      kind?: unknown;
      disputeId?: unknown;
    } | null;
    const kind = typeof body?.kind === "string" ? body.kind : null;
    const disputeId = typeof body?.disputeId === "string" ? body.disputeId : null;
    if (!kind || !(RAIL_WRITABLE_KINDS as readonly string[]).includes(kind)) {
      return NextResponse.json({ error: "Unsupported event kind" }, { status: 400 });
    }
    if (!disputeId) {
      return NextResponse.json({ error: "disputeId is required" }, { status: 400 });
    }

    const { data: claim } = await userScoped(supabase, user.id)
      .table("claims")
      .select("id")
      .eq("id", claimId)
      .single();
    if (!claim) {
      return NextResponse.json({ error: "Claim not found" }, { status: 404 });
    }

    const { data: dispute } = await userScoped(supabase, user.id)
      .table("dispute_outcomes")
      .select("id, claim_id")
      .eq("id", disputeId)
      .single();
    if (!dispute || dispute.claim_id !== claimId) {
      return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
    }

    await emitCaseEvent(supabase, user.id, {
      claimId,
      disputeId,
      kind: kind as CaseEventKind,
      // References only (module contract) — the dispute_id column IS the ref.
      payload: {},
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[case-events POST] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
