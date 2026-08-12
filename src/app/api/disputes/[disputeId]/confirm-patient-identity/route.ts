/**
 * POST /api/disputes/[disputeId]/confirm-patient-identity — Block C2.
 *
 * Persists the user's confirmation that the bill's patient is them, resolving the
 * server-computed patient-name mismatch. The GET handler at
 * /api/disputes/[disputeId] (and the Case File route) reads
 * dispute.metadata.patientIdentityResolved and, when true, short-circuits the live
 * name-compare so patientNameMismatch → null and the MVDL `patientIdentity`
 * readiness item closes. Supports undo via { confirmed: false }.
 *
 * Body: { confirmed?: boolean }  (omitted/true → confirm; false → undo)
 * Auth: Firebase bearer token; verifies the user owns the dispute (IDOR).
 * Returns: { success: true, patientIdentityResolved: boolean }
 *
 * Mirrors the confirm-same-plan write pattern (dispute_outcomes.metadata spread-
 * merge). The reskin affordance is gated client-side by dispute_letter_v3_design;
 * the write itself is a truthful user statement, safe to honor whenever present.
 */
import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";
import { driftMachineryApplies } from "@/lib/disputes/evidence-fingerprint";

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
  { params }: { params: Promise<{ disputeId: string }> },
) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    confirmed?: unknown;
    choice?: unknown;
    correctedName?: unknown;
  } | null;
  // Default to confirm; an explicit { confirmed: false } undoes a prior confirm.
  const confirmed = body?.confirmed !== false;
  // S294 — WHICH resolution the user picked, persisted for the flywheel. The
  // one-click "This is me" surface (CaseNeedsPanel) used to post a bare
  // {confirmed:true}: the letter then silently adopted the ACCOUNT name for a
  // bill whose patient was someone else, with no dependent path offered
  // (observed live: "Patient: Andrew Ullmann Test" on Nicole's bill). Both
  // surfaces now share the three-choice flow and the answer is DATA:
  //   me        — the bill means the account holder
  //   dependent — the bill's patient is a covered dependent; their name stands
  //   wrong     — the bill's name is wrong; correctedName is the truth
  // Older clients that post {confirmed} alone stay valid (choice stays unset).
  const choice =
    body?.choice === "me" || body?.choice === "dependent" || body?.choice === "wrong"
      ? body.choice
      : null;
  const correctedName =
    choice === "wrong" && typeof body?.correctedName === "string"
      ? body.correctedName.trim().slice(0, 120)
      : null;

  const { disputeId } = await params;
  const supabase = createServerClient();

  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const { data: dispute, error: fetchErr } = await userScoped(supabase, user.id)
    .table("dispute_outcomes")
    .select("id, metadata, status, sent_at")
    .eq("id", disputeId)
    .single();
  if (fetchErr || !dispute) {
    return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
  }

  // S311 (tree §2.1) — a VOID letter is a read-only exhibit (S308's rule;
  // this route was reachable from a cancelled letter's page and its write
  // would have moved the frozen row's updated_at). Sent letters stay
  // writable — their metadata is the knowledge layer follow-ups read.
  // One rule, stated once: driftMachineryApplies === false ⇔ void.
  if (
    !driftMachineryApplies(
      (dispute.status as string | null) ?? null,
      dispute.sent_at ? new Date(dispute.sent_at as string) : null,
    )
  ) {
    return NextResponse.json({ error: "letter_void" }, { status: 409 });
  }

  const baseMetadata = (dispute.metadata as Record<string, unknown>) ?? {};
  const nextMetadata: Record<string, unknown> = {
    ...baseMetadata,
    patientIdentityResolved: confirmed,
  };
  if (confirmed) {
    nextMetadata.patientIdentityResolvedAt = new Date().toISOString();
    // Persisted only when the client sent one — a bare {confirmed} (legacy
    // surface, replayed request) must not erase a previously recorded choice.
    if (choice) {
      nextMetadata.patientIdentityChoice = choice;
      nextMetadata.patientCorrectedName = correctedName; // null unless "wrong"
    }
  } else {
    // Undo clears the whole answer, not just the flag — a stale choice under
    // an unresolved mismatch would masquerade as data.
    delete nextMetadata.patientIdentityChoice;
    delete nextMetadata.patientCorrectedName;
  }

  const { error: updateErr } = await userScoped(supabase, user.id)
    .table("dispute_outcomes")
    .update({
      metadata: nextMetadata,
      updated_at: new Date().toISOString(),
    })
    .eq("id", dispute.id);

  if (updateErr) {
    console.error("[confirm-patient-identity] update failed:", updateErr);
    return NextResponse.json(
      { error: "Failed to persist confirmation" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    success: true,
    patientIdentityResolved: confirmed,
  });
}
