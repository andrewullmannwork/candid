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

/**
 * Client-writable event kinds. Deliberately tiny and per-kind gated — new
 * entries are a reviewed code change here, never a pass-through of client
 * input.
 *
 * `collection_resumed_reported` is a RAIL door: it requires the rail surface
 * AND the spine, because a rail-ON/spine-OFF misconfiguration would return 200
 * and write nothing.
 *
 * `letter_downloaded` (S300 phase 2b, completing emitter coverage 18/18) is a
 * LETTER-page action and gates on the SPINE ONLY. Every other emitter in the
 * product is spine-gated; rail-gating this one would mean that at promote —
 * when PROD runs `case_timeline_v1` ON and `case_rail_v1` OFF so the spine can
 * accumulate history before the UI ships — every download in that window went
 * unrecorded. Downloads are the drafted-never-sent stall signal; losing that
 * window would quietly cost the flywheel the data the promote sequence exists
 * to collect.
 */
const RAIL_WRITABLE_KINDS: readonly CaseEventKind[] = [
  "collection_resumed_reported",
  "letter_downloaded",
];

/** Kinds that additionally require the rail SURFACE flag (see above). */
const RAIL_SURFACE_KINDS: ReadonlySet<CaseEventKind> = new Set([
  "collection_resumed_reported",
]);

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

    // The spine gates EVERY write here; the rail surface gates only the rail's
    // own door (see RAIL_SURFACE_KINDS). Kind is validated below, before use.
    if (!(await isFeatureEnabled("case_timeline_v1"))) {
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
    if (
      RAIL_SURFACE_KINDS.has(kind as CaseEventKind) &&
      !(await isFeatureEnabled("case_rail_v1"))
    ) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
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
