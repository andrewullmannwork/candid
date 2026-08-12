/**
 * POST /api/claims/[claimId]/provider-contact — S74 Pillar 1, claim-scoped
 * since S310.
 *
 * Updates the provider mailing contact (and name) on the claim. The bill
 * parser fills `claims.metadata.provider` with `{ name, address, npi }` when
 * those fields appear on the bill, but legacy claims (or sparsely-parsed
 * bills) often have no address — and without an address the printed dispute
 * letter has no recipient line. This endpoint lets the user fill it in, and
 * (S310 / F14a) correct the parsed provider NAME the letters print.
 *
 * S310 — moved here from /api/disputes/[disputeId]/provider-contact (deleted;
 * its only work was hopping dispute → claim before this same merge, which
 * kept the claim page from using it at all). Every reader resolves from the
 * same path (claims.metadata.provider → resolvePlanContext /
 * extractProviderContact / evidence resolver), so the next GET on any surface
 * reflects the update automatically; a name change drifts the letter
 * fingerprint and live drafts rebuild themselves.
 *
 * Flywheel (S310): the first user name-change stashes the parser's original
 * as `parsedName` (parser said X, user said Y — an alias-pair precision
 * signal), and `nameConfirmedAt` records that a user vouched for the printed
 * name (set by both the claim-details confirm and any explicit correction).
 *
 * Auth: Firebase bearer token. Verifies the user owns the claim before any
 * mutation.
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
  /**
   * S310 — name-vouch action ("These look right" on the claim-details block).
   * Stamps `nameConfirmedAt` without requiring field values and without
   * touching the address-confirm stamp or provenance source.
   */
  confirmName?: boolean;
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
  { params }: { params: Promise<{ claimId: string }> },
) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

  const body = (await req.json().catch(() => null)) as ProviderContactInput | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const isConfirmOnly = body.confirm === true;
  const isNameConfirm = body.confirmName === true;

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
  const hasFieldValues =
    !!next.name || !!next.address || !!next.phone || !!next.npi || anyAddressField;

  // Confirm-only / name-confirm carry no new values; every other call must
  // provide at least one field so the user can incrementally fill in whatever's
  // on the bill.
  if (!isConfirmOnly && !isNameConfirm && !hasFieldValues) {
    return NextResponse.json(
      { error: "Provide at least one provider field (name, address, phone, or npi)." },
      { status: 400 },
    );
  }

  const { data: claim } = await userScoped(supabase, user.id)
    .table("claims")
    .select("id, metadata")
    .eq("id", claimId)
    .single();
  if (!claim) {
    return NextResponse.json({ error: "Claim not found" }, { status: 404 });
  }

  const existingMetadata = (claim.metadata as Record<string, unknown> | null) ?? {};
  const existingProvider =
    (existingMetadata.provider as Record<string, unknown> | undefined) ?? {};

  const nowIso = new Date().toISOString();

  // S310 flywheel — the FIRST user name-change preserves the parser's original
  // beside the correction. Only when the incumbent name was parse-sourced (a
  // second user edit must not overwrite the stash with the first edit's value).
  const stashParsedName =
    next.name !== undefined &&
    existingProvider.parsedName === undefined &&
    typeof existingProvider.name === "string" &&
    existingProvider.name.trim().length > 0 &&
    existingProvider.source !== "user_correction" &&
    existingProvider.name !== next.name;

  // Merge — keep any fields the user didn't touch this round. Confirm-only and
  // name-confirm calls carry no field values: they leave name/address/etc
  // untouched (source preserved); a real save marks user_correction and
  // supersedes a prior address confirm. `nameConfirmedAt` stamps whenever the
  // user vouches for the name — explicitly (confirmName) or by correcting it.
  const mergedProvider: Record<string, unknown> = {
    ...existingProvider,
    ...(next.name !== undefined ? { name: next.name } : {}),
    ...(next.address !== undefined ? { address: next.address } : {}),
    ...(next.phone !== undefined ? { phone: next.phone } : {}),
    ...(next.npi !== undefined ? { npi: next.npi } : {}),
    ...(stashParsedName ? { parsedName: existingProvider.name } : {}),
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
    // unless this IS the confirm action (name-confirm leaves it untouched).
    confirmedAt: isConfirmOnly
      ? nowIso
      : hasFieldValues
        ? null
        : (existingProvider.confirmedAt ?? null),
    ...(isNameConfirm || next.name !== undefined ? { nameConfirmedAt: nowIso } : {}),
    // Preserve doc_extraction source on confirm flows (nothing was user-typed);
    // a real save marks it user_correction.
    source: hasFieldValues
      ? "user_correction"
      : (existingProvider.source ?? "doc_extraction"),
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
      nameConfirmedAt: mergedProvider.nameConfirmedAt ?? null,
      source: mergedProvider.source ?? "user_correction",
    },
  });
}
