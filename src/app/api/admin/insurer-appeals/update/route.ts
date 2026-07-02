/**
 * POST /api/admin/insurer-appeals/update — dispute-letters v2 S3.
 *
 * Direct admin edit of an insurer's appeals address in the shared catalog (no proposal
 * round-trip). Powers the "Recently updated — revise" section so an admin can correct an
 * already-accepted address (e.g. fix a bad accept). Validated the same way as accept, so
 * nothing malformed reaches the shared catalog.
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
  const { supabase } = ctx;

  const body = (await req.json()) as {
    insurerId?: string;
    values?: {
      address_line_1?: string;
      address_line_2?: string | null;
      city?: string;
      state?: string;
      postal_code?: string;
      phone?: string;
    };
  };
  if (!body.insurerId || !body.values) {
    return NextResponse.json({ error: "insurerId + values required" }, { status: 400 });
  }

  const v = body.values;
  const normState = (v.state ?? "").toUpperCase();
  const addrErrors = validateUsAddress({
    addressLine1: v.address_line_1 ?? "",
    addressLine2: v.address_line_2 ?? "",
    city: v.city ?? "",
    state: normState,
    postalCode: v.postal_code ?? "",
  });
  const firstError = Object.values(addrErrors)[0];
  if (firstError) return NextResponse.json({ error: firstError }, { status: 400 });

  const { error } = await supabase
    .from("insurer_catalog")
    .update({
      appeals_address_line_1: v.address_line_1 ?? null,
      appeals_address_line_2: v.address_line_2 ?? null,
      appeals_city: v.city ?? null,
      appeals_state: normState || null,
      appeals_postal_code: v.postal_code ?? null,
      appeals_phone: v.phone ?? null,
      appeals_source: "admin_verified",
      appeals_confidence: 1.0,
      appeals_last_confirmed_at: new Date().toISOString(),
      appeals_updated_at: new Date().toISOString(),
    })
    .eq("id", body.insurerId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
