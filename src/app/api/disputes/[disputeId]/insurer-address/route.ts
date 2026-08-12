/**
 * POST /api/disputes/[disputeId]/insurer-address — Block C2.2 (S152).
 *
 * Dual-write for a user-supplied insurer appeals address:
 *   1. User-scoped — persists `dispute.metadata.insurerAddressOverride` so THIS
 *      user's letter mails to the address immediately (Pattern 1 #14 user-scoped
 *      write; consumed by resolvePlanContext's overlay → letter body + recipient
 *      card + readiness + insurer_address_missing gap suppression).
 *   2. Community — queues a `proposed_correction` to
 *      insurer_appeals_proposed_changes for admin review. The shared
 *      insurer_catalog address only changes if an admin approves it; we never
 *      overwrite admin_verified data silently. Non-fatal: the user's letter is
 *      unblocked even if the community proposal can't be written.
 *
 * Body: { insurerId?, insurerName?, addressLine1, addressLine2?, city, state, postalCode, phone? }
 * Auth: Firebase bearer token; verifies the user owns the dispute (IDOR).
 * Returns: { success: true, insurerAddressOverride }
 */
import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";
import { driftMachineryApplies } from "@/lib/disputes/evidence-fingerprint";
import { validateUsAddress } from "@/lib/address/validate-us-address";
import type { InsurerAddressOverride } from "@/lib/disputes/plan-context";
import { notifyInsurerAppealsProposal } from "@/lib/disputes/insurer-appeals-notify";

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
    insurerId?: unknown;
    insurerName?: unknown;
    addressLine1?: unknown;
    addressLine2?: unknown;
    city?: unknown;
    state?: unknown;
    postalCode?: unknown;
    phone?: unknown;
  } | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const addressLine1 = str(body.addressLine1);
  const addressLine2 = str(body.addressLine2);
  const city = str(body.city);
  const state = str(body.state).toUpperCase();
  const postalCode = str(body.postalCode);
  const phone = str(body.phone);
  const insurerId = str(body.insurerId) || null;
  const insurerName = str(body.insurerName) || null;

  // Shared validator — same rules the provider form + insurer modal enforce
  // (required line1/city/state/ZIP + real-state set + ZIP format).
  const addrErrors = validateUsAddress({ addressLine1, addressLine2, city, state, postalCode });
  const firstError = Object.values(addrErrors)[0];
  if (firstError) {
    return NextResponse.json({ error: firstError }, { status: 400 });
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

  // (1) User-scoped override on the dispute — used on this user's letter now.
  const insurerAddressOverride: InsurerAddressOverride = {
    insurerId,
    insurerName,
    addressLine1,
    addressLine2: addressLine2 || null,
    city,
    state,
    postalCode,
    phone: phone || null,
    confirmedAt: new Date().toISOString(),
  };
  const baseMetadata = (dispute.metadata as Record<string, unknown>) ?? {};
  const { error: updateErr } = await userScoped(supabase, user.id)
    .table("dispute_outcomes")
    .update({
      metadata: { ...baseMetadata, insurerAddressOverride },
      updated_at: new Date().toISOString(),
    })
    .eq("id", dispute.id);
  if (updateErr) {
    console.error("[insurer-address] override persist failed:", updateErr);
    return NextResponse.json({ error: "Failed to save address" }, { status: 500 });
  }

  // (2) Community proposal → admin queue (non-fatal). The shared catalog address
  // only changes if an admin approves; never overwrite admin_verified silently.
  if (insurerId) {
    try {
      const { data: current } = await supabase
        .from("insurer_catalog")
        .select("name, appeals_address_line_1, appeals_address_line_2, appeals_city, appeals_state, appeals_postal_code, appeals_phone, appeals_source")
        .eq("id", insurerId)
        .maybeSingle();
      await supabase.from("insurer_appeals_proposed_changes").insert({
        insurer_id: insurerId,
        proposed_by: "user_correction",
        proposed_by_user_id: user.id,
        current_values: current
          ? {
              address_line_1: current.appeals_address_line_1,
              address_line_2: current.appeals_address_line_2,
              city: current.appeals_city,
              state: current.appeals_state,
              postal_code: current.appeals_postal_code,
              phone: current.appeals_phone,
              source: current.appeals_source,
            }
          : null,
        proposed_values: {
          address_line_1: addressLine1,
          address_line_2: addressLine2 || null,
          city,
          state,
          postal_code: postalCode,
          phone: phone || null,
        },
        status: "pending",
      });

      // Real-time admin nudge so the proposal doesn't sit unseen in the queue.
      // Fail-soft (never throws); the user's letter already has the override.
      await notifyInsurerAppealsProposal({
        insurerName: current?.name ?? insurerName ?? "Unknown insurer",
        source: "user_correction",
        current: current?.appeals_address_line_1
          ? {
              addressLine1: current.appeals_address_line_1,
              addressLine2: current.appeals_address_line_2,
              city: current.appeals_city,
              state: current.appeals_state,
              postalCode: current.appeals_postal_code,
              phone: current.appeals_phone,
            }
          : null,
        proposed: {
          addressLine1,
          addressLine2: addressLine2 || null,
          city,
          state,
          postalCode,
          phone: phone || null,
        },
      });
    } catch (err) {
      // Non-fatal — the user's letter already has the override.
      console.error("[insurer-address] community proposal enqueue failed (non-fatal):", err);
    }
  }

  return NextResponse.json({ success: true, insurerAddressOverride });
}
