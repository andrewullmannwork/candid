/**
 * Shared admin-auth guard for admin API routes.
 *
 * Firebase ID token (Authorization: Bearer) → users.is_admin, returning a
 * service-role Supabase client, the admin's users PK, and the admin's email on
 * success. Originally lifted verbatim from the inline copies in
 * /api/admin/canonical-quality + /api/admin/flags + /api/admin/pipeline/scrape.
 * S273 admin-cleanup migrates every remaining hand-rolled admin route onto this
 * helper so the Firebase→is_admin check lives in exactly one place.
 *
 * adminEmail is sourced from users.email (the DB row), used by the routes that
 * write logAdminAction audit entries (subscriptions, users/delete, query, …).
 *
 * Auth response codes are intentional: 401 for a missing/invalid Bearer token,
 * 403 ("Admin access required") for an authenticated non-admin — the 403 avoids
 * leaking admin-account existence to a signed-in probe.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

export type RequireAdminResult =
  | {
      ok: true;
      supabase: ReturnType<typeof createServerClient>;
      adminUserId: string;
      adminEmail: string;
    }
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
      .select("id, is_admin, email")
      .eq("firebase_uid", decoded.uid)
      .single();
    if (!user?.is_admin) {
      return {
        ok: false,
        response: NextResponse.json({ error: "Admin access required" }, { status: 403 }),
      };
    }
    return {
      ok: true,
      supabase,
      adminUserId: user.id as string,
      adminEmail: (user.email as string) ?? "unknown",
    };
  } catch {
    return { ok: false, response: NextResponse.json({ error: "Invalid token" }, { status: 401 }) };
  }
}
