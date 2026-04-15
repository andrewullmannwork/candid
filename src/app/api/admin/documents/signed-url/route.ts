/**
 * GET /api/admin/documents/signed-url?path=...
 *
 * Returns a temporary signed URL for viewing a document PDF in the admin panel.
 * Admin-only endpoint.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    const supabase = createServerClient();
    const { data: adminUser } = await supabase
      .from("users")
      .select("is_admin")
      .eq("firebase_uid", decoded.uid)
      .single();
    if (!adminUser?.is_admin) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const path = req.nextUrl.searchParams.get("path");
  if (!path) {
    return NextResponse.json({ error: "path parameter required" }, { status: 400 });
  }

  const supabase = createServerClient();
  const { data, error } = await supabase.storage
    .from("documents")
    .createSignedUrl(path, 300); // 5 minute expiry

  if (error || !data?.signedUrl) {
    return NextResponse.json({ error: "Failed to generate signed URL" }, { status: 500 });
  }

  return NextResponse.json({ url: data.signedUrl });
}
