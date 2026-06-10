/**
 * POST /api/disputes/insurer-appeals/confirm
 *
 * Phase 6.2 verify-strip endpoint. Handles two actions:
 *   - `confirmed`           → bump verification_count + last_confirmed_at,
 *                              log an event in insurer_appeals_confirmations.
 *   - `proposed_correction` → open a proposed_changes row with the user's
 *                              replacement values for admin review.
 *
 * Deduping: the same user confirming the same insurer within 30 days is a
 * no-op so the UI can re-render safely without spamming the log.
 */
import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";

const DEDUPE_WINDOW_DAYS = 30;

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const decoded = await getAuthUser(req);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json()) as {
    insurerId?: string;
    action?: "confirmed" | "proposed_correction";
    proposedValues?: {
      addressLine1?: string;
      addressLine2?: string;
      city?: string;
      state?: string;
      postalCode?: string;
      phone?: string;
    };
  };

  if (!body.insurerId || !body.action) {
    return NextResponse.json({ error: "insurerId + action required" }, { status: 400 });
  }

  const supabase = createServerClient();
  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const { data: insurer } = await supabase
    .from("insurer_catalog")
    .select("id, appeals_address_line_1, appeals_address_line_2, appeals_city, appeals_state, appeals_postal_code, appeals_phone, appeals_source, appeals_verification_count")
    .eq("id", body.insurerId)
    .maybeSingle();
  if (!insurer) return NextResponse.json({ error: "Insurer not found" }, { status: 404 });

  if (body.action === "confirmed") {
    // Dedupe: skip if this user already confirmed recently.
    const cutoff = new Date(Date.now() - DEDUPE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data: recent } = await userScoped(supabase, user.id)
      .table("insurer_appeals_confirmations")
      .select("id")
      .eq("insurer_id", insurer.id)
      .eq("action", "confirmed")
      .gte("confirmed_at", cutoff)
      .limit(1)
      .maybeSingle();
    if (recent) {
      return NextResponse.json({ ok: true, deduped: true });
    }

    await userScoped(supabase, user.id).table("insurer_appeals_confirmations").insert({
      insurer_id: insurer.id,
      action: "confirmed",
      metadata: {},
    });

    await supabase
      .from("insurer_catalog")
      .update({
        appeals_verification_count: (insurer.appeals_verification_count ?? 0) + 1,
        appeals_last_confirmed_at: new Date().toISOString(),
      })
      .eq("id", insurer.id);

    return NextResponse.json({ ok: true });
  }

  if (body.action === "proposed_correction") {
    if (!body.proposedValues?.addressLine1) {
      return NextResponse.json(
        { error: "proposedValues.addressLine1 required for corrections" },
        { status: 400 },
      );
    }

    await supabase.from("insurer_appeals_proposed_changes").insert({
      insurer_id: insurer.id,
      proposed_by: "user_correction",
      proposed_by_user_id: user.id,
      source_document_id: null,
      source_excerpt: null,
      current_values: {
        address_line_1: insurer.appeals_address_line_1,
        address_line_2: insurer.appeals_address_line_2,
        city: insurer.appeals_city,
        state: insurer.appeals_state,
        postal_code: insurer.appeals_postal_code,
        phone: insurer.appeals_phone,
        source: insurer.appeals_source,
      },
      proposed_values: {
        address_line_1: body.proposedValues.addressLine1,
        address_line_2: body.proposedValues.addressLine2 ?? null,
        city: body.proposedValues.city ?? null,
        state: body.proposedValues.state ?? null,
        postal_code: body.proposedValues.postalCode ?? null,
        phone: body.proposedValues.phone ?? null,
      },
      status: "pending",
    });

    await userScoped(supabase, user.id).table("insurer_appeals_confirmations").insert({
      insurer_id: insurer.id,
      action: "proposed_correction",
      metadata: { source: "verify_strip" },
    });

    return NextResponse.json({ ok: true, queued: true });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
