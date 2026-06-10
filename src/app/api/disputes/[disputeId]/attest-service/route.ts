/**
 * POST /api/disputes/[disputeId]/attest-service — Block C2.
 *
 * Persists the set of claim_line_item ids the user has attested (under their own
 * name) were NOT rendered. Idempotent set-write: the client sends the complete
 * desired set each time (attest = include the line; undo = resend without it; []
 * clears all). The GET / case-file / redraft handlers read
 * dispute.metadata.serviceAttestedLineIds and pass it to resolveEvidence, which
 * reclassifies each matching line to `service_not_rendered` (documentary spine,
 * Tier-1) per §1c/§1f L2.
 *
 * Body: { attestedLineItemIds: string[] }  (the full desired set)
 * Auth: Firebase bearer token; verifies the user owns the dispute (IDOR).
 * Returns: { success: true, serviceAttestedLineIds: string[] }
 *
 * Mirrors the confirm-same-plan write pattern (dispute_outcomes.metadata spread-
 * merge). Foreign line ids are inert — buildLineItemEvidence only honors ids that
 * match this dispute's own line items.
 */
import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";

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
    attestedLineItemIds?: unknown;
    serviceAttestationReviewed?: unknown;
    attestingAsName?: unknown;
  } | null;
  const raw = body?.attestedLineItemIds;
  if (!Array.isArray(raw) || !raw.every((x) => typeof x === "string")) {
    return NextResponse.json(
      { error: "attestedLineItemIds must be an array of strings" },
      { status: 400 },
    );
  }
  // Idempotent set-write; dedupe defensively.
  const serviceAttestedLineIds = Array.from(new Set(raw as string[]));

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
    .select("id, metadata")
    .eq("id", disputeId)
    .single();
  if (fetchErr || !dispute) {
    return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
  }

  const baseMetadata = (dispute.metadata as Record<string, unknown>) ?? {};
  const nextMetadata: Record<string, unknown> = {
    ...baseMetadata,
    serviceAttestedLineIds,
    serviceAttestedAt: new Date().toISOString(),
  };
  // Block C2 item 2 — persist ALL user input so the gate never re-prompts and the
  // adopted name survives reloads. Only set when provided (never clobber existing).
  if (body?.serviceAttestationReviewed === true) {
    nextMetadata.serviceAttestationReviewed = true;
  }
  if (typeof body?.attestingAsName === "string" && body.attestingAsName.trim()) {
    nextMetadata.attestingAsName = body.attestingAsName.trim().slice(0, 120);
  }

  const { error: updateErr } = await userScoped(supabase, user.id)
    .table("dispute_outcomes")
    .update({
      metadata: nextMetadata,
      updated_at: new Date().toISOString(),
    })
    .eq("id", dispute.id);

  if (updateErr) {
    console.error("[attest-service] update failed:", updateErr);
    return NextResponse.json(
      { error: "Failed to persist attestation" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    success: true,
    serviceAttestedLineIds,
    serviceAttestationReviewed: nextMetadata.serviceAttestationReviewed === true,
    attestingAsName: (nextMetadata.attestingAsName as string | undefined) ?? null,
  });
}
