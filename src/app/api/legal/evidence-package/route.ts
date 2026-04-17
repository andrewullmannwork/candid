/**
 * GET /api/legal/evidence-package — Compile and download evidence package
 *
 * Query params:
 * - claimId: claim UUID (required)
 * - disputeId: dispute UUID (optional)
 *
 * Auth: Firebase bearer token.
 * Returns: plain text evidence document.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { compileEvidencePackage, formatEvidencePackageAsText } from "@/lib/legal/evidence-compiler";

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const claimId = req.nextUrl.searchParams.get("claimId");
  const disputeId = req.nextUrl.searchParams.get("disputeId") || undefined;

  if (!claimId) {
    return NextResponse.json({ error: "claimId required" }, { status: 400 });
  }

  const supabase = createServerClient();

  // Resolve user
  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const pkg = await compileEvidencePackage(supabase, {
    claimId,
    userId: user.id,
    disputeId,
  });

  const text = formatEvidencePackageAsText(pkg);

  return new NextResponse(text, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="evidence-package-${claimId.slice(0, 8)}.txt"`,
    },
  });
}
