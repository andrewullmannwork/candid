/**
 * POST /api/admin/insurer-appeals/review
 *
 * Admin accepts or rejects a pending proposed change. On accept, the
 * insurer_catalog.appeals_* fields are overwritten and marked as
 * admin_verified; on reject, the row is moved to `status='rejected'`.
 */
import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { validateUsAddress } from "@/lib/address/validate-us-address";

async function requireAdmin(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    const supabase = createServerClient();
    const { data: user } = await supabase
      .from("users")
      .select("id, is_admin")
      .eq("firebase_uid", decoded.uid)
      .single();
    if (!user?.is_admin) return null;
    return { user, supabase };
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const ctx = await requireAdmin(req);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { user, supabase } = ctx;

  const body = (await req.json()) as {
    proposalId?: string;
    decision?: "accept" | "reject";
    notes?: string;
    // dispute-letters v2 S3 — optional admin-edited address (fix a field before accept).
    // Same snake_case shape as proposed_values; when present it (validated) overrides
    // proposed_values on write. Absent → accept writes proposed_values as-is (legacy).
    editedValues?: {
      address_line_1?: string;
      address_line_2?: string | null;
      city?: string;
      state?: string;
      postal_code?: string;
      phone?: string;
    };
  };
  if (!body.proposalId || !body.decision) {
    return NextResponse.json(
      { error: "proposalId + decision required" },
      { status: 400 },
    );
  }

  const { data: proposal } = await supabase
    .from("insurer_appeals_proposed_changes")
    .select("id, insurer_id, proposed_values, status")
    .eq("id", body.proposalId)
    .maybeSingle();

  if (!proposal) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (proposal.status !== "pending") {
    return NextResponse.json({ error: "Already reviewed" }, { status: 400 });
  }

  const proposed = (proposal.proposed_values ?? {}) as {
    address_line_1?: string;
    address_line_2?: string | null;
    city?: string;
    state?: string;
    postal_code?: string;
    phone?: string;
  };
  const ADDR_KEYS = ["address_line_1", "address_line_2", "city", "state", "postal_code", "phone"] as const;
  // Did the admin actually change a field (vs accept as-proposed)? Drives the audit note.
  const adminEdited =
    body.editedValues != null &&
    ADDR_KEYS.some((k) => (body.editedValues?.[k] ?? "") !== (proposed[k] ?? ""));

  if (body.decision === "accept") {
    // Final values = admin edits when supplied, else the original proposal. Validated
    // either way — nothing invalid (e.g. a test "st"/"Test") reaches the shared catalog.
    const finalValues = body.editedValues ?? proposed;
    const normState = (finalValues.state ?? "").toUpperCase();
    const addrErrors = validateUsAddress({
      addressLine1: finalValues.address_line_1 ?? "",
      addressLine2: finalValues.address_line_2 ?? "",
      city: finalValues.city ?? "",
      state: normState,
      postalCode: finalValues.postal_code ?? "",
    });
    const firstError = Object.values(addrErrors)[0];
    if (firstError) return NextResponse.json({ error: firstError }, { status: 400 });

    await supabase
      .from("insurer_catalog")
      .update({
        appeals_address_line_1: finalValues.address_line_1 ?? null,
        appeals_address_line_2: finalValues.address_line_2 ?? null,
        appeals_city: finalValues.city ?? null,
        appeals_state: normState || null,
        appeals_postal_code: finalValues.postal_code ?? null,
        appeals_phone: finalValues.phone ?? null,
        appeals_source: "admin_verified",
        appeals_confidence: 1.0,
        appeals_verification_count: 1,
        appeals_last_confirmed_at: new Date().toISOString(),
        appeals_updated_at: new Date().toISOString(),
      })
      .eq("id", proposal.insurer_id);
  }

  await supabase
    .from("insurer_appeals_proposed_changes")
    .update({
      status: body.decision === "accept" ? "accepted" : "rejected",
      reviewed_by_admin_id: user.id,
      reviewed_at: new Date().toISOString(),
      admin_notes:
        body.decision === "accept" && adminEdited
          ? `${body.notes ? `${body.notes} ` : ""}[admin-edited before accept]`
          : body.notes ?? null,
    })
    .eq("id", proposal.id);

  return NextResponse.json({ ok: true });
}
