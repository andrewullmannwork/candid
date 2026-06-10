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
import { userScoped } from "@/lib/security/user-scoped";

interface ProviderAddressFieldsInput {
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
}

interface ProviderContactInput {
  name?: string;
  address?: string;
  /** Block C2 — structured address parts (persisted alongside the display string). */
  addressFields?: ProviderAddressFieldsInput;
  phone?: string;
  npi?: string;
  /**
   * Block C2 — confirm-only action. When true, stamps `confirmedAt` on the
   * provider metadata WITHOUT requiring new field values (the user is confirming
   * the already-extracted address is correct). Claim-scoped: persists to
   * claims.metadata.provider so it's reused across disputes for the same claim.
   */
  confirm?: boolean;
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

  const isConfirmOnly = body.confirm === true;

  const af = body.addressFields ?? {};
  const next = {
    name: sanitize(body.name, 200),
    address: sanitize(body.address, 500),
    phone: sanitize(body.phone, 50),
    // NPI is 10 digits — accept up to 12 chars to tolerate punctuation, but
    // strip non-digits before persisting.
    npi: sanitize(body.npi, 12)?.replace(/\D/g, "") || undefined,
    // Block C2 — structured address parts (persisted for scalable re-edit; the
    // display `address` string above is still what the letter renders).
    addressFields: {
      addressLine1: sanitize(af.addressLine1, 200),
      addressLine2: sanitize(af.addressLine2, 200),
      city: sanitize(af.city, 120),
      state: sanitize(af.state, 2)?.toUpperCase(),
      postalCode: sanitize(af.postalCode, 12),
    },
  };

  const anyAddressField = Object.values(next.addressFields).some(Boolean);

  // Confirm-only carries no new values; every other call must provide at least
  // one field so the user can incrementally fill in whatever's on the bill.
  if (
    !isConfirmOnly &&
    !next.name &&
    !next.address &&
    !next.phone &&
    !next.npi &&
    !anyAddressField
  ) {
    return NextResponse.json(
      { error: "Provide at least one provider field (name, address, phone, or npi)." },
      { status: 400 },
    );
  }

  // Ownership: dispute must belong to user, AND we need the linked claim id to
  // mutate the claim's metadata.
  const { data: dispute } = await userScoped(supabase, user.id)
    .table("dispute_outcomes")
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

  const { data: claim } = await userScoped(supabase, user.id)
    .table("claims")
    .select("id, metadata")
    .eq("id", dispute.claim_id)
    .single();
  if (!claim) {
    return NextResponse.json({ error: "Claim not found" }, { status: 404 });
  }

  const existingMetadata = (claim.metadata as Record<string, unknown> | null) ?? {};
  const existingProvider =
    (existingMetadata.provider as Record<string, unknown> | undefined) ?? {};

  const nowIso = new Date().toISOString();

  // Merge — keep any fields the user didn't touch this round. Confirm-only calls
  // carry no field values: they leave name/address/etc untouched and only stamp
  // confirmedAt (the user is attesting the already-extracted address is right).
  const mergedProvider: Record<string, unknown> = {
    ...existingProvider,
    ...(next.name !== undefined ? { name: next.name } : {}),
    ...(next.address !== undefined ? { address: next.address } : {}),
    ...(next.phone !== undefined ? { phone: next.phone } : {}),
    ...(next.npi !== undefined ? { npi: next.npi } : {}),
    // Block C2 — persist structured address parts when provided (only on a real
    // save; confirm-only doesn't carry them).
    ...(anyAddressField
      ? {
          addressFields: {
            ...(typeof existingProvider.addressFields === "object" &&
            existingProvider.addressFields
              ? (existingProvider.addressFields as Record<string, unknown>)
              : {}),
            ...(next.addressFields.addressLine1 !== undefined
              ? { addressLine1: next.addressFields.addressLine1 }
              : {}),
            ...(next.addressFields.addressLine2 !== undefined
              ? { addressLine2: next.addressFields.addressLine2 }
              : {}),
            ...(next.addressFields.city !== undefined
              ? { city: next.addressFields.city }
              : {}),
            ...(next.addressFields.state !== undefined
              ? { state: next.addressFields.state }
              : {}),
            ...(next.addressFields.postalCode !== undefined
              ? { postalCode: next.addressFields.postalCode }
              : {}),
          },
        }
      : {}),
    // A fresh save (new values) supersedes a prior confirm — clear confirmedAt
    // unless this IS the confirm action.
    confirmedAt: isConfirmOnly ? nowIso : null,
    // Preserve doc_extraction source on confirm-only (the address wasn't
    // user-typed); a real save marks it user_correction.
    source: isConfirmOnly
      ? (existingProvider.source ?? "doc_extraction")
      : "user_correction",
    updated_at: nowIso,
  };

  const nextMetadata = { ...existingMetadata, provider: mergedProvider };

  const { error: updateError } = await userScoped(supabase, user.id)
    .table("claims")
    .update({ metadata: nextMetadata, updated_at: new Date().toISOString() })
    .eq("id", claim.id);

  if (updateError) {
    console.error("[provider-contact] update failed:", updateError);
    return NextResponse.json({ error: "Failed to update provider contact" }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    providerContact: {
      name: mergedProvider.name ?? null,
      address: mergedProvider.address ?? null,
      addressFields: mergedProvider.addressFields ?? null,
      phone: mergedProvider.phone ?? null,
      npi: mergedProvider.npi ?? null,
      confirmedAt: mergedProvider.confirmedAt ?? null,
      source: mergedProvider.source ?? "user_correction",
    },
  });
}
