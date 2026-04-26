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

  if (body.decision === "accept") {
    const proposed = proposal.proposed_values as {
      address_line_1?: string;
      address_line_2?: string | null;
      city?: string;
      state?: string;
      postal_code?: string;
      phone?: string;
    };

    await supabase
      .from("insurer_catalog")
      .update({
        appeals_address_line_1: proposed.address_line_1 ?? null,
        appeals_address_line_2: proposed.address_line_2 ?? null,
        appeals_city: proposed.city ?? null,
        appeals_state: proposed.state ?? null,
        appeals_postal_code: proposed.postal_code ?? null,
        appeals_phone: proposed.phone ?? null,
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
      admin_notes: body.notes ?? null,
    })
    .eq("id", proposal.id);

  return NextResponse.json({ ok: true });
}
