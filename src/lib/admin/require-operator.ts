/**
 * requireOperator — the auth guard for every DFY operator API route (S330).
 *
 * Mirrors requireAdmin (one Firebase→users lookup, same response codes) with
 * three differences that ARE the D8 spec:
 *   1. The role is `users.is_operator` — the named operator privilege — and an
 *      admin has the same permissions on this section (Andrew, S330 decision 3).
 *      The returned `role` names which one acted; routes stamp it into the
 *      audit trail so the record always reads correctly.
 *   2. Dark when the flag is off: every operator route answers 404, so the
 *      section's existence is not observable before it ships.
 *   3. The config-backed IP allowlist (D8 access hardening): when enforced and
 *      non-empty, a request from an unlisted address is refused — checked
 *      AFTER the token so the refusal cannot be used to probe for the section.
 *
 * 403 ("Operator access required") for an authenticated non-operator — like
 * requireAdmin, it avoids leaking role-account existence to a signed-in probe.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { readDfyState, ipAdmitted, type DfyConfig } from "@/lib/dfy/config";
import type { OperatorRole } from "@/lib/security/operator-scoped";

export type RequireOperatorResult =
  | {
      ok: true;
      supabase: ReturnType<typeof createServerClient>;
      operatorUserId: string;
      operatorEmail: string;
      role: OperatorRole;
      config: DfyConfig;
      /** First hop of x-forwarded-for (or x-real-ip); null when absent. */
      ip: string | null;
    }
  | { ok: false; response: NextResponse };

export function requestIp(req: NextRequest): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() || null;
}

export async function requireOperator(req: NextRequest): Promise<RequireOperatorResult> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    const supabase = createServerClient();
    const [state, userRes] = await Promise.all([
      readDfyState(supabase),
      supabase
        .from("users")
        .select("id, is_admin, is_operator, email")
        .eq("firebase_uid", decoded.uid)
        .single(),
    ]);
    // Dark: the section does not exist while the flag is off.
    if (!state.enabled) {
      return { ok: false, response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
    }
    const user = userRes.data as { id: string; is_admin?: boolean; is_operator?: boolean; email?: string } | null;
    const role: OperatorRole | null = user?.is_operator ? "operator" : user?.is_admin ? "admin" : null;
    if (!user || !role) {
      return {
        ok: false,
        response: NextResponse.json({ error: "Operator access required" }, { status: 403 }),
      };
    }
    const ip = requestIp(req);
    if (!ipAdmitted(ip, state.config)) {
      return {
        ok: false,
        response: NextResponse.json({ error: "Operator access required", code: "ip_not_allowed" }, { status: 403 }),
      };
    }
    return {
      ok: true,
      supabase,
      operatorUserId: user.id,
      operatorEmail: user.email ?? "unknown",
      role,
      config: state.config,
      ip,
    };
  } catch {
    return { ok: false, response: NextResponse.json({ error: "Invalid token" }, { status: 401 }) };
  }
}
