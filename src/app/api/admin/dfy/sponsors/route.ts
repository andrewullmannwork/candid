/**
 * /api/admin/dfy/sponsors — sponsor reference data (S330, R17 Path C). ADMIN only:
 * a sponsor is a commercial counterparty, not an operator's matter.
 *   GET            → { sponsors }
 *   POST { code, name, contactEmail?, agreementSignedAt?, active?, terms? } → upsert by code
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/require-admin";
import { logAdminAction } from "@/lib/admin/audit-log";
import { listSponsors, normalizeSponsorCode, parseSponsor, SPONSOR_COLUMNS } from "@/lib/dfy/sponsors";

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ sponsors: await listSponsors(auth.supabase) });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  const { supabase, adminUserId, adminEmail } = auth;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const code = typeof body.code === "string" ? normalizeSponsorCode(body.code) : "";
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 160) : "";
  if (!/^[A-Z0-9][A-Z0-9-]{2,39}$/.test(code)) return NextResponse.json({ error: "code: 3–40 letters, digits or dashes" }, { status: 400 });
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  const agreementSignedAt = typeof body.agreementSignedAt === "string" && /^\d{4}-\d{2}-\d{2}/.test(body.agreementSignedAt) ? body.agreementSignedAt : null;
  const row = {
    code,
    name,
    contact_email: typeof body.contactEmail === "string" && body.contactEmail.trim() ? body.contactEmail.trim().toLowerCase() : null,
    agreement_signed_at: agreementSignedAt,
    active: body.active !== false,
    terms: body.terms && typeof body.terms === "object" ? body.terms : {},
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from("dfy_sponsors").upsert(row, { onConflict: "code" }).select(SPONSOR_COLUMNS).single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await logAdminAction({ adminUserId, adminEmail, action: "dfy_sponsor_upsert", targetTable: "dfy_sponsors", details: `${code} (${name}) agreement=${agreementSignedAt ?? "none"} active=${row.active}` });
  return NextResponse.json({ ok: true, sponsor: parseSponsor(data) });
}
