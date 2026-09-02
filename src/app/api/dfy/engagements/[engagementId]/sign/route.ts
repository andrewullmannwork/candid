/**
 * POST /api/dfy/engagements/[engagementId]/sign — the member signs ONE instrument (S330).
 * Body: { type, signedName, accepted: true }. Each instrument is its own click;
 * the server composes, hashes, records, renders and files it (sign.ts).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/security/require-authenticated-user";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";
import { parseEngagementRow, DFY_ENGAGEMENT_COLUMNS } from "@/lib/security/operator-scoped";
import { readDfyState } from "@/lib/dfy/config";
import { requiredDfyConsents, type DfyInstrumentType } from "@/lib/dfy/paper";
import { DfySignError, signInstrument } from "@/lib/dfy/sign";
import { requestIp } from "@/lib/admin/require-operator";

export async function POST(req: NextRequest, { params }: { params: Promise<{ engagementId: string }> }) {
  const user = await requireAuthenticatedUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.isAnonymous) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const supabase = createServerClient();
  const state = await readDfyState(supabase);
  if (!state.enabled) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { engagementId } = await params;

  let body: { type?: unknown; signedName?: unknown; accepted?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (body.accepted !== true) return NextResponse.json({ error: "You must confirm that you have read the document", code: "not_accepted" }, { status: 400 });
  const type = body.type as DfyInstrumentType;

  const { data } = await userScoped(supabase, user.id)
    .table("dfy_engagements")
    .select(DFY_ENGAGEMENT_COLUMNS)
    .eq("id", engagementId)
    .maybeSingle();
  const e = parseEngagementRow(data);
  if (!e) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!requiredDfyConsents(e.payer).includes(type)) {
    return NextResponse.json({ error: "Unknown instrument", code: "bad_type" }, { status: 400 });
  }
  const { data: userRow } = await supabase.from("users").select("display_name").eq("id", user.id).maybeSingle();

  try {
    const result = await signInstrument({
      supabase,
      engagement: e,
      member: { id: user.id, email: user.email, displayName: (userRow as { display_name?: string | null } | null)?.display_name ?? null },
      type,
      signedName: typeof body.signedName === "string" ? body.signedName : "",
      ip: requestIp(req),
      userAgent: req.headers.get("user-agent"),
      config: state.config,
    });
    return NextResponse.json({
      ok: true,
      type,
      signed: { signedName: result.ref.signedName, signedAt: result.ref.signedAt },
      completed: result.completed,
      status: result.engagement.status,
    });
  } catch (err) {
    if (err instanceof DfySignError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    console.error("[dfy sign] unexpected:", err);
    return NextResponse.json({ error: "Could not sign", code: "internal" }, { status: 500 });
  }
}
