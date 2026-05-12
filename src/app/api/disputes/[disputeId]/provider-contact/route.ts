/**
 * POST /api/disputes/[disputeId]/provider-contact — S74 Pillar 1
 *
 * Updates the provider mailing contact on the dispute's linked claim. The bill
 * parser fills `claims.metadata.provider` with `{ name, address, npi }` when
 * those fields appear on the EOB, but legacy claims (or sparsely-parsed bills)
 * often have no address — and without an address the printed dispute letter
 * has no recipient line. This endpoint lets the user fill it in.
 *
 * Writes shape: `claims.metadata.provider` merged with the new fields. The
 * dispute letter recipient block + DisputeRecipientCard re-resolve from the
 * same path (resolvePlanContext → extractProviderContact), so the next /disputes
 * GET reflects the update automatically.
 *
 * Auth: Firebase bearer token. Verifies the user owns the dispute → linked
 * claim before any mutation.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

interface ProviderContactInput {
  name?: string;
  address?: string;
  phone?: string;
  npi?: string;
}

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

function sanitize(value: unknown, max = 500): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ disputeId: string }> },
) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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

  const body = (await req.json().catch(() => null)) as ProviderContactInput | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const next = {
    name: sanitize(body.name, 200),
    address: sanitize(body.address, 500),
    phone: sanitize(body.phone, 50),
    // NPI is 10 digits — accept up to 12 chars to tolerate punctuation, but
    // strip non-digits before persisting.
    npi: sanitize(body.npi, 12)?.replace(/\D/g, "") || undefined,
  };

  // At least one field must be provided so the user can incrementally fill in
  // whatever they have on the bill.
  if (!next.name && !next.address && !next.phone && !next.npi) {
    return NextResponse.json(
      { error: "Provide at least one provider field (name, address, phone, or npi)." },
      { status: 400 },
    );
  }

  // Ownership: dispute must belong to user, AND we need the linked claim id to
  // mutate the claim's metadata.
  const { data: dispute } = await supabase
    .from("dispute_outcomes")
    .select("id, user_id, claim_id")
    .eq("id", disputeId)
    .single();
  if (!dispute || dispute.user_id !== user.id) {
    return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
  }
  if (!dispute.claim_id) {
    return NextResponse.json(
      { error: "Dispute has no linked claim" },
      { status: 400 },
    );
  }

  const { data: claim } = await supabase
    .from("claims")
    .select("id, metadata")
    .eq("id", dispute.claim_id)
    .eq("user_id", user.id)
    .single();
  if (!claim) {
    return NextResponse.json({ error: "Claim not found" }, { status: 404 });
  }

  const existingMetadata = (claim.metadata as Record<string, unknown> | null) ?? {};
  const existingProvider =
    (existingMetadata.provider as Record<string, unknown> | undefined) ?? {};

  // Merge — keep any fields the user didn't touch this round.
  const mergedProvider: Record<string, unknown> = {
    ...existingProvider,
    ...(next.name !== undefined ? { name: next.name } : {}),
    ...(next.address !== undefined ? { address: next.address } : {}),
    ...(next.phone !== undefined ? { phone: next.phone } : {}),
    ...(next.npi !== undefined ? { npi: next.npi } : {}),
    source: "user_correction",
    updated_at: new Date().toISOString(),
  };

  const nextMetadata = { ...existingMetadata, provider: mergedProvider };

  const { error: updateError } = await supabase
    .from("claims")
    .update({ metadata: nextMetadata, updated_at: new Date().toISOString() })
    .eq("id", claim.id)
    .eq("user_id", user.id);

  if (updateError) {
    console.error("[provider-contact] update failed:", updateError);
    return NextResponse.json({ error: "Failed to update provider contact" }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    providerContact: {
      name: mergedProvider.name ?? null,
      address: mergedProvider.address ?? null,
      phone: mergedProvider.phone ?? null,
      npi: mergedProvider.npi ?? null,
      source: "user_correction",
    },
  });
}
