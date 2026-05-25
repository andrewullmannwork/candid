/**
 * Admin CRUD for file_hash_blocklist (Ing-G.4, mig 119).
 *
 *   GET    /api/admin/documents/blocklist          → list all blocked hashes
 *   POST   /api/admin/documents/blocklist          → add hash (body: file_hash, reason, notes?)
 *   DELETE /api/admin/documents/blocklist?hash=... → remove hash
 *
 * Admin-only — auth gate mirrors /api/admin/documents/signed-url
 * (Firebase ID token → users.is_admin check). Server-only writes; the
 * blocklist table has no RLS and is read via service_role from the upload
 * route helper at src/lib/security/file-hash-blocklist.ts.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

interface AdminContext {
  adminUserId: string;
  supabase: ReturnType<typeof createServerClient>;
}

async function requireAdmin(req: NextRequest): Promise<
  | { ok: true; ctx: AdminContext }
  | { ok: false; response: NextResponse }
> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    const supabase = createServerClient();
    const { data: user } = await supabase
      .from("users")
      .select("id, is_admin")
      .eq("firebase_uid", decoded.uid)
      .single();
    if (!user?.is_admin) {
      return { ok: false, response: NextResponse.json({ error: "Admin access required" }, { status: 403 }) };
    }
    return { ok: true, ctx: { adminUserId: user.id as string, supabase } };
  } catch {
    return { ok: false, response: NextResponse.json({ error: "Invalid token" }, { status: 401 }) };
  }
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { data, error } = await auth.ctx.supabase
    .from("file_hash_blocklist")
    .select("file_hash, reason, added_by_admin_id, added_at, notes")
    .order("added_at", { ascending: false });

  if (error) {
    console.error("[blocklist] list failed:", error.message);
    return NextResponse.json({ error: "Failed to load blocklist" }, { status: 500 });
  }

  const adminIds = [...new Set((data || []).map((r) => r.added_by_admin_id))];
  const emailMap = new Map<string, string>();
  if (adminIds.length > 0) {
    const { data: admins } = await auth.ctx.supabase
      .from("users")
      .select("id, email")
      .in("id", adminIds);
    for (const a of admins || []) emailMap.set(a.id as string, a.email as string);
  }

  return NextResponse.json({
    rows: (data || []).map((r) => ({
      file_hash: r.file_hash,
      reason: r.reason,
      added_by_email: emailMap.get(r.added_by_admin_id as string) || null,
      added_at: r.added_at,
      notes: r.notes,
    })),
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: { file_hash?: unknown; reason?: unknown; notes?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const fileHash = typeof body.file_hash === "string" ? body.file_hash.trim().toLowerCase() : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const notes = typeof body.notes === "string" ? body.notes.trim() || null : null;

  if (!SHA256_HEX.test(fileHash)) {
    return NextResponse.json(
      { error: "file_hash must be 64-character lowercase hex (SHA-256)" },
      { status: 400 },
    );
  }
  if (!reason) {
    return NextResponse.json({ error: "reason is required" }, { status: 400 });
  }

  const { error } = await auth.ctx.supabase
    .from("file_hash_blocklist")
    .insert({
      file_hash: fileHash,
      reason,
      added_by_admin_id: auth.ctx.adminUserId,
      notes,
    });

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "This hash is already blocked" }, { status: 409 });
    }
    console.error("[blocklist] insert failed:", error.message);
    return NextResponse.json({ error: "Failed to add hash" }, { status: 500 });
  }

  console.log(
    `[blocklist] added hash=${fileHash.slice(0, 8)}… by admin=${auth.ctx.adminUserId} reason="${reason}"`,
  );
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const fileHash = (req.nextUrl.searchParams.get("hash") || "").trim().toLowerCase();
  if (!SHA256_HEX.test(fileHash)) {
    return NextResponse.json(
      { error: "hash query param must be 64-character lowercase hex" },
      { status: 400 },
    );
  }

  const { error } = await auth.ctx.supabase
    .from("file_hash_blocklist")
    .delete()
    .eq("file_hash", fileHash);

  if (error) {
    console.error("[blocklist] delete failed:", error.message);
    return NextResponse.json({ error: "Failed to remove hash" }, { status: 500 });
  }

  console.log(
    `[blocklist] removed hash=${fileHash.slice(0, 8)}… by admin=${auth.ctx.adminUserId}`,
  );
  return NextResponse.json({ ok: true });
}
