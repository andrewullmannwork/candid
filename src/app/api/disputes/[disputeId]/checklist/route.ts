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
 * Guided Steps v1 (S297): also accepts an optional short `note` (≤500 chars),
 * stored at `dispute.metadata.checklistNotes[key]` — additive; boolean-only
 * callers are unaffected, and either field may arrive alone.
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

  let body: { key?: unknown; done?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const key = typeof body.key === "string" ? body.key : null;
  const done = typeof body.done === "boolean" ? body.done : null;
  // Guided Steps v1 (S297) — additive optional note (packC:*/packD:* rows save
  // a short free-text note, e.g. a USPS tracking or confirmation number).
  // Existing callers send { key, done } only and are unaffected; note-only
  // writes leave the checklist booleans untouched.
  const note = typeof body.note === "string" ? body.note : null;
  if (!key || !KEY_RE.test(key) || (done == null && note == null)) {
    return NextResponse.json(
      { error: "Expected { key: string (1-64 chars), done?: boolean, note?: string } with at least one of done/note" },
      { status: 400 },
    );
  }
  if (note != null && note.length > 500) {
    return NextResponse.json({ error: "note exceeds 500 characters" }, { status: 400 });
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
    ...(done != null ? { [key]: done } : {}),
  };
  // S297 — notes live beside the booleans, keyed identically, so a note can
  // exist on an unchecked row (tracking number saved before "Receipt saved").
  const priorNotes = (meta.checklistNotes as Record<string, string> | undefined) ?? {};
  const checklistNotes = {
    ...priorNotes,
    ...(note != null ? { [key]: note } : {}),
  };
  // S297 noteHistory (Andrew) — bank the replaced non-empty value (last 5,
  // server-stamped) so an accidental delete is recoverable.
  let checklistNoteHistory =
    (meta.checklistNoteHistory as
      | Record<string, Array<{ note: string; replacedAt: string }>>
      | undefined) ?? {};
  if (note != null) {
    const priorNote = priorNotes[key];
    if (typeof priorNote === "string" && priorNote.length > 0 && priorNote !== note) {
      checklistNoteHistory = {
        ...checklistNoteHistory,
        [key]: [
          ...(checklistNoteHistory[key] ?? []),
          { note: priorNote, replacedAt: new Date().toISOString() },
        ].slice(-5),
      };
    }
  }

  const { error: updateErr } = await userScoped(supabase, user.id)
    .table("dispute_outcomes")
    .update({
      metadata: { ...meta, checklist, checklistNotes, checklistNoteHistory },
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

  return NextResponse.json({ checklist, checklistNotes });
}
