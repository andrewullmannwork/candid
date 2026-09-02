/**
 * GET /api/dfy/engagements/[engagementId]/instrument?type=… — the UNSIGNED
 * instrument as a PDF, for the wet-ink path (S330): a plan that will not accept
 * an e-signed designation gets the same instrument printed, signed by hand,
 * and uploaded through the member's ordinary upload flow. Same template, same
 * slots, no signature block — a handwritten signature line instead.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/security/require-authenticated-user";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";
import { parseEngagementRow, DFY_ENGAGEMENT_COLUMNS } from "@/lib/security/operator-scoped";
import { readDfyState } from "@/lib/dfy/config";
import { PDF_INSTRUMENTS, renderInstrument, requiredDfyConsents, type DfyInstrumentType } from "@/lib/dfy/paper";
import { buildInstrumentContext } from "@/lib/dfy/sign";

export async function GET(req: NextRequest, { params }: { params: Promise<{ engagementId: string }> }) {
  const user = await requireAuthenticatedUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const supabase = createServerClient();
  const state = await readDfyState(supabase);
  if (!state.enabled) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { engagementId } = await params;
  const type = req.nextUrl.searchParams.get("type") as DfyInstrumentType | null;
  const { data } = await userScoped(supabase, user.id).table("dfy_engagements").select(DFY_ENGAGEMENT_COLUMNS).eq("id", engagementId).maybeSingle();
  const e = parseEngagementRow(data);
  if (!e) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!type || !requiredDfyConsents(e.payer).includes(type) || !PDF_INSTRUMENTS.has(type)) {
    return NextResponse.json({ error: "Unknown instrument" }, { status: 400 });
  }
  const { data: userRow } = await supabase.from("users").select("display_name").eq("id", user.id).maybeSingle();
  const ctx = await buildInstrumentContext(supabase, e, { id: user.id, email: user.email, displayName: (userRow as { display_name?: string | null } | null)?.display_name ?? null }, state.config, new Date());
  const instrument = renderInstrument(type, ctx);
  const [{ renderToBuffer }, { InstrumentPdf }, React] = await Promise.all([import("@react-pdf/renderer"), import("@/lib/dfy/instrument-pdf"), import("react")]);
  const pdf = await renderToBuffer(React.createElement(InstrumentPdf, { instrument, signature: null, counterparty: null, engagementId: e.id }) as never);
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${instrument.title.replace(/[^\w .-]+/g, "")} (to sign by hand).pdf"` },
  });
}
