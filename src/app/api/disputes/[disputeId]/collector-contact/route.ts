/**
 * POST /api/disputes/[disputeId]/collector-contact — S301
 *
 * Captures the collection agency's identity for a bill that went to collections:
 * name, mailing address, original creditor, and the collector's account /
 * reference number. Before this endpoint the collector was captured ONCE, inside
 * CollectorModal at escalation time, and could never be edited afterwards — so a
 * debt-validation letter drafted without an address (the default: only the agency
 * NAME is required in that modal) had no path to ever gain one.
 *
 * ── Why this writes the CLAIM, not the dispute ──────────────────────────────
 *
 * Same split the provider contact already uses, and for the same reason
 * (agenda §0.7 — each fact asked once, in its owner's home):
 *
 *   KNOWLEDGE layer  `claims.metadata.collector`   — what we currently know about
 *                                                    the agency chasing THIS bill.
 *                                                    Claim-scoped, so every letter
 *                                                    on the bill reads it and the
 *                                                    user types it once.
 *   RECORD layer     `dispute.metadata.collector`   — who a given letter was
 *                    `metadata.sentVersions[].collector`  actually addressed to when
 *                                                    mailed. Immutable (S74.5 /
 *                                                    S299 recipient-as-mailed);
 *                                                    THIS ROUTE NEVER TOUCHES IT.
 *
 * So editing the address after a letter was mailed updates what the next letter
 * uses and leaves the mailed one exactly as mailed.
 *
 * Writes shape: `claims.metadata.collector` merged with the new fields, mirroring
 * `provider-contact`'s merge semantics (incremental fill; a real save supersedes a
 * prior confirm and marks the source `user_correction`).
 *
 * Auth: Firebase bearer token. Verifies the user owns the dispute → linked claim
 * before any mutation (foreign row → 404 anti-enumeration).
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";
import { driftMachineryApplies } from "@/lib/disputes/evidence-fingerprint";

interface CollectorAddressFieldsInput {
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
}

interface CollectorContactInput {
  name?: string;
  address?: string;
  addressFields?: CollectorAddressFieldsInput;
  originalCreditor?: string;
  /** The collector's own file number for this debt — printed on their notice. */
  accountNumber?: string;
  /** Confirm-only: stamp confirmedAt without requiring new values. */
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

  let body: CollectorContactInput;
  try {
    body = (await req.json()) as CollectorContactInput;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
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

  const isConfirmOnly = body.confirm === true;
  const af = body.addressFields ?? {};
  const next = {
    name: sanitize(body.name, 200),
    address: sanitize(body.address, 500),
    originalCreditor: sanitize(body.originalCreditor, 200),
    accountNumber: sanitize(body.accountNumber, 100),
    addressFields: {
      addressLine1: sanitize(af.addressLine1, 200),
      addressLine2: sanitize(af.addressLine2, 200),
      city: sanitize(af.city, 120),
      state: sanitize(af.state, 2)?.toUpperCase(),
      postalCode: sanitize(af.postalCode, 12),
    },
  };

  const anyAddressField = Object.values(next.addressFields).some(Boolean);

  if (
    !isConfirmOnly &&
    !next.name &&
    !next.address &&
    !next.originalCreditor &&
    !next.accountNumber &&
    !anyAddressField
  ) {
    return NextResponse.json(
      {
        error:
          "Provide at least one collector field (name, address, originalCreditor, or accountNumber).",
      },
      { status: 400 },
    );
  }

  const { data: dispute } = await userScoped(supabase, user.id)
    .table("dispute_outcomes")
    .select("id, user_id, claim_id, status, sent_at")
    .eq("id", disputeId)
    .single();
  if (!dispute || dispute.user_id !== user.id) {
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
  if (!dispute.claim_id) {
    return NextResponse.json({ error: "Dispute has no linked claim" }, { status: 400 });
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
  const existingCollector =
    (existingMetadata.collector as Record<string, unknown> | undefined) ?? {};

  const nowIso = new Date().toISOString();

  const mergedCollector: Record<string, unknown> = {
    ...existingCollector,
    ...(next.name !== undefined ? { name: next.name } : {}),
    ...(next.address !== undefined ? { address: next.address } : {}),
    ...(next.originalCreditor !== undefined
      ? { originalCreditor: next.originalCreditor }
      : {}),
    ...(next.accountNumber !== undefined ? { accountNumber: next.accountNumber } : {}),
    ...(anyAddressField
      ? {
          addressFields: {
            ...(typeof existingCollector.addressFields === "object" &&
            existingCollector.addressFields
              ? (existingCollector.addressFields as Record<string, unknown>)
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
    confirmedAt: isConfirmOnly ? nowIso : null,
    source: isConfirmOnly
      ? (existingCollector.source ?? "user_supplied")
      : "user_correction",
    updated_at: nowIso,
  };

  const nextMetadata = { ...existingMetadata, collector: mergedCollector };

  const { error: updateError } = await userScoped(supabase, user.id)
    .table("claims")
    .update({ metadata: nextMetadata, updated_at: new Date().toISOString() })
    .eq("id", claim.id);

  if (updateError) {
    console.error("[collector-contact] update failed:", updateError);
    return NextResponse.json(
      { error: "Failed to update collector contact" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    success: true,
    collectorContact: {
      name: mergedCollector.name ?? null,
      address: mergedCollector.address ?? null,
      addressFields: mergedCollector.addressFields ?? null,
      originalCreditor: mergedCollector.originalCreditor ?? null,
      accountNumber: mergedCollector.accountNumber ?? null,
      confirmedAt: mergedCollector.confirmedAt ?? null,
      source: mergedCollector.source ?? "user_correction",
    },
  });
}
