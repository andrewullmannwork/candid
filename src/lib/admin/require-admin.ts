/**
 * Shared admin-auth guard for admin API routes.
 *
 * Firebase ID token (Authorization: Bearer) → users.is_admin, returning a
 * service-role Supabase client + the admin's users PK on success. Lifted verbatim
 * from the inline copies in /api/admin/canonical-quality + /api/admin/flags +
 * /api/admin/pipeline/scrape so new routes stop hand-rolling it (PR3a uses it for
 * /api/admin/promotion-quarantine). The pre-existing inline copies are left as-is;
 * migrating them is out of scope for this PR.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

export type RequireAdminResult =
  | { ok: true; supabase: ReturnType<typeof createServerClient>; adminUserId: string }
  | { ok: false; response: NextResponse };

export async function requireAdmin(req: NextRequest): Promise<RequireAdminResult> {
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
      return {
        ok: false,
        response: NextResponse.json({ error: "Admin access required" }, { status: 403 }),
      };
    }
    return { ok: true, supabase, adminUserId: user.id as string };
  } catch {
    return { ok: false, response: NextResponse.json({ error: "Invalid token" }, { status: 401 }) };
  }
}
