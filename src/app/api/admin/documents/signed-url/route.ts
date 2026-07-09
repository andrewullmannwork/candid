/**
 * GET /api/admin/documents/signed-url?path=...
 *
 * Returns a temporary signed URL for viewing a document PDF in the admin panel.
 * Admin-only endpoint.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin/require-admin";

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

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
