/**
 * POST /api/disputes/[disputeId]/checklist — unified case timeline (S286).
 *
 * Persists a single "What you need to do" check-off into
 * `dispute.metadata.checklist` ({[rowKey]: boolean}) so check state survives
 * reload. Previously these were session-local in the UnifiedTodo (mailed-it,
 * read-through, details confirmation, after-sent follow-up done marks) —
 * tolerable for a side checklist, broken for the authoritative case spine.
 *
 * Keys are client-defined row ids (e.g. "mailcert", "read", "details",
 * "after-fu-2026-07-23-deadline_interim"). Values are booleans; a false write
 * un-checks. User-scoped write to the user's own dispute row only (Pattern 1
 * #14 — no canonical surface involved).
 *
 * Auth: Firebase bearer token. Verifies user owns the dispute (userScoped).
 */
import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";

const KEY_RE = /^[a-zA-Z0-9_.:-]{1,64}$/;

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

  let body: { key?: unknown; done?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const key = typeof body.key === "string" ? body.key : null;
  const done = typeof body.done === "boolean" ? body.done : null;
  if (!key || !KEY_RE.test(key) || done == null) {
    return NextResponse.json(
      { error: "Expected { key: string (1-64 chars), done: boolean }" },
      { status: 400 },
    );
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
    .select("id, metadata")
    .eq("id", disputeId)
    .single();
  if (fetchErr || !dispute) {
    return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
  }

  const meta = (dispute.metadata as Record<string, unknown>) ?? {};
  const checklist = {
    ...((meta.checklist as Record<string, boolean> | undefined) ?? {}),
    [key]: done,
  };

  const { error: updateErr } = await userScoped(supabase, user.id)
    .table("dispute_outcomes")
    .update({
      metadata: { ...meta, checklist },
      updated_at: new Date().toISOString(),
    })
    .eq("id", dispute.id);

  if (updateErr) {
    console.error("[dispute-checklist] update failed:", updateErr);
    return NextResponse.json(
      { error: "Failed to persist check" },
      { status: 500 },
    );
  }

  return NextResponse.json({ checklist });
}
