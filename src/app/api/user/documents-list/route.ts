/**
 * GET /api/user/documents-list
 *
 * Returns the authenticated user's processed documents for use in the /support
 * page's "Link a document" picker (B2.3 per D-§1.B.3-A). Distinct from
 * /api/documents/recent which is gated to async_ingestion_ux_v1 + 24h lookback
 * + 30-page filter for banner surfacing — this endpoint is the general user-
 * scoped documents-list source for B2.3's picker.
 *
 * Returns at most 50 most-recent processed documents per user. RLS-aware
 * (resolves user_id via Firebase Bearer token + queries scoped to that user).
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";

interface UserDocument {
  id: string;
  doc_type: string | null;
  file_name: string;
  created_at: string;
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let decoded;
  try {
    decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const supabase = createServerClient();

  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();

  if (!user) {
    return NextResponse.json({ documents: [] });
  }

  const { data: docs, error } = await userScoped(supabase, user.id)
    .table("documents")
    .select("id, doc_type, file_name, created_at")
    .eq("status", "processed")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    console.error("[user/documents-list] Query failed:", error);
    return NextResponse.json({ error: "Failed to load documents" }, { status: 500 });
  }

  return NextResponse.json({ documents: (docs ?? []) as UserDocument[] });
}
