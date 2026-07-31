/**
 * POST /api/claims/[claimId]/checklist — Guided Steps v1 (S297).
 *
 * Persists one guided-step attestation into `claims.metadata.guideSteps`:
 *   { [stepId]: { checkedAt: string | null, note?: string } }
 *
 * Mirrors the dispute checklist route's shape (same KEY_RE, same userScoped
 * ownership, foreign row → 404 anti-enum). Claim-scoped because Pack A′ is the
 * BILL's call log — shared by every letter on the bill, surviving escalation.
 *
 * Body: { stepId: string; checked?: boolean; note?: string } — at least one of
 * checked/note. `checked: true` stamps a SERVER-side timestamp (clients never
 * supply times — handoff §3.9); `checked: false` nulls it; `note` persists
 * independently of the checkbox (blur-save), capped short (v1 data ceiling:
 * checkbox + timestamp + one short note — no parsed dates, no engine writes).
 *
 * Auth: Firebase bearer token. Verifies user owns the claim (userScoped).
 */
import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";

const KEY_RE = /^[a-zA-Z0-9_.:-]{1,64}$/;
const NOTE_MAX = 500;

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
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { stepId?: unknown; checked?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const stepId = typeof body.stepId === "string" ? body.stepId : null;
  const checked = typeof body.checked === "boolean" ? body.checked : null;
  const note = typeof body.note === "string" ? body.note : null;
  if (!stepId || !KEY_RE.test(stepId) || (checked == null && note == null)) {
    return NextResponse.json(
      {
        error:
          "Expected { stepId: string (1-64 chars), checked?: boolean, note?: string } with at least one of checked/note",
      },
      { status: 400 },
    );
  }
  if (note != null && note.length > NOTE_MAX) {
    return NextResponse.json(
      { error: `note exceeds ${NOTE_MAX} characters` },
      { status: 400 },
    );
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

  const { data: claim, error: fetchErr } = await userScoped(supabase, user.id)
    .table("claims")
    .select("id, metadata")
    .eq("id", claimId)
    .single();
  if (fetchErr || !claim) {
    return NextResponse.json({ error: "Claim not found" }, { status: 404 });
  }

  const meta = (claim.metadata as Record<string, unknown>) ?? {};
  const guideSteps = {
    ...((meta.guideSteps as Record<
      string,
      { checkedAt: string | null; note?: string; noteHistory?: Array<{ note: string; replacedAt: string }> }
    > | undefined) ?? {}),
  };
  const prior = guideSteps[stepId] ?? { checkedAt: null };
  const next: {
    checkedAt: string | null;
    note?: string;
    noteHistory?: Array<{ note: string; replacedAt: string }>;
  } = { ...prior };
  if (checked === true) next.checkedAt = new Date().toISOString();
  if (checked === false) next.checkedAt = null;
  if (note != null) {
    // S297 noteHistory (Andrew) — these logs are evidence; before replacing a
    // non-empty note with something different, bank the old value (last 5,
    // server-stamped) so an accidental delete is recoverable.
    const priorNote = typeof prior.note === "string" ? prior.note : null;
    if (priorNote != null && priorNote.length > 0 && priorNote !== note) {
      next.noteHistory = [
        ...(prior.noteHistory ?? []),
        { note: priorNote, replacedAt: new Date().toISOString() },
      ].slice(-5);
    }
    next.note = note;
  }
  guideSteps[stepId] = next;

  const { error: updateErr } = await userScoped(supabase, user.id)
    .table("claims")
    .update({
      metadata: { ...meta, guideSteps },
      updated_at: new Date().toISOString(),
    })
    .eq("id", claim.id);

  if (updateErr) {
    console.error("[claim-checklist] update failed:", updateErr);
    return NextResponse.json(
      { error: "Failed to persist step" },
      { status: 500 },
    );
  }

  return NextResponse.json({ guideSteps });
}
