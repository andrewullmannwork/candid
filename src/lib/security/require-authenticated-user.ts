import type { NextRequest } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

export interface AuthenticatedUser {
  id: string;
  firebase_uid: string;
  email: string;
  /** S315 — TOKEN-derived (sign_in_provider), not a DB read: true for Firebase
   *  anonymous-provider sessions (the no-account bill check). Routes that act
   *  in the user's name (letter generation) refuse when true. */
  isAnonymous: boolean;
}

/**
 * Verifies the request's Authorization header carries a valid Firebase Bearer
 * token and resolves the matching Supabase users row. Returns null on any
 * failure (missing header, malformed/expired token, unknown user).
 *
 * Use in every API route that operates on user-scoped data. Always derive
 * resource ownership from the returned `id` — never trust user IDs from the
 * request body (B9-1 §C1/C2 IDOR class).
 */
export async function requireAuthenticatedUser(
  req: NextRequest,
): Promise<AuthenticatedUser | null> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    const supabase = createServerClient();
    const { data: user } = await supabase
      .from("users")
      .select("id, firebase_uid, email")
      .eq("firebase_uid", decoded.uid)
      .single();
    if (!user) return null;
    return {
      id: user.id as string,
      firebase_uid: user.firebase_uid as string,
      email: user.email as string,
      isAnonymous: decoded.firebase?.sign_in_provider === "anonymous",
    };
  } catch {
    return null;
  }
}
