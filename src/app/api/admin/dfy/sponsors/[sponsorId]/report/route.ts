/**
 * GET /api/admin/dfy/sponsors/[sponsorId]/report — the AGGREGATE-ONLY sponsor
 * report (S330). Counts by status and determination, suppressed below the
 * standing floor; never a member, a claim, or a document. This is the only
 * thing a sponsor may ever be shown.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/require-admin";
import { loadSponsorReport, parseSponsor, SPONSOR_COLUMNS } from "@/lib/dfy/sponsors";

export async function GET(req: NextRequest, { params }: { params: Promise<{ sponsorId: string }> }) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  const { sponsorId } = await params;
  const { data } = await auth.supabase.from("dfy_sponsors").select(SPONSOR_COLUMNS).eq("id", sponsorId).maybeSingle();
  const sponsor = parseSponsor(data);
  if (!sponsor) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ report: await loadSponsorReport(auth.supabase, sponsor) });
}
