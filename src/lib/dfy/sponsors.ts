/**
 * sponsors — the employer-paid lane's reference data (R17 Path C), S330.
 *
 * Paper before code, as a TABLE: a sponsor code is valid at intake only when a
 * dfy_sponsors row carries it, `active`, with `agreement_signed_at` set. The
 * engagement records both the code as typed (sponsor_ref) and the resolved
 * sponsor_id, so a renamed code never orphans a matter.
 *
 * Sponsor REPORTING is aggregate-only: counts per status/outcome, suppressed
 * below the platform's standing k-anonymity floor. A sponsor never sees a
 * member, a claim, or a document — the data wall the disclosure promises.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { listSponsorReportRows } from "@/lib/security/operator-scoped";

export interface DfySponsor {
  id: string;
  code: string;
  name: string;
  contact_email: string | null;
  agreement_signed_at: string | null;
  active: boolean;
  terms: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export const SPONSOR_COLUMNS = "id, code, name, contact_email, agreement_signed_at, active, terms, created_at, updated_at";

/** The standing aggregate floor — counts below this are suppressed. */
export const SPONSOR_REPORT_K = 5;

export function normalizeSponsorCode(code: string): string {
  return code.trim().toUpperCase();
}

export function parseSponsor(raw: unknown): DfySponsor | null {
  const r = (raw && typeof raw === "object" ? raw : null) as Record<string, unknown> | null;
  if (!r || typeof r.id !== "string" || typeof r.code !== "string" || typeof r.name !== "string") return null;
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    contact_email: typeof r.contact_email === "string" ? r.contact_email : null,
    agreement_signed_at: typeof r.agreement_signed_at === "string" ? r.agreement_signed_at : null,
    active: r.active === true,
    terms: (r.terms && typeof r.terms === "object" ? r.terms : {}) as Record<string, unknown>,
    created_at: typeof r.created_at === "string" ? r.created_at : "",
    updated_at: typeof r.updated_at === "string" ? r.updated_at : "",
  };
}

/** Pure: may this sponsor's code be used at intake right now? */
export function sponsorCodeUsable(s: DfySponsor | null): { ok: boolean; reason: string | null } {
  if (!s) return { ok: false, reason: "we don't recognize this code" };
  if (!s.active) return { ok: false, reason: "this employer's program is inactive" };
  if (!s.agreement_signed_at) return { ok: false, reason: "this employer's agreement isn't signed yet" };
  return { ok: true, reason: null };
}

export async function loadSponsorByCode(supabase: SupabaseClient, code: string): Promise<DfySponsor | null> {
  const { data } = await supabase.from("dfy_sponsors").select(SPONSOR_COLUMNS).eq("code", normalizeSponsorCode(code)).maybeSingle();
  return parseSponsor(data);
}

export async function listSponsors(supabase: SupabaseClient): Promise<DfySponsor[]> {
  const { data } = await supabase.from("dfy_sponsors").select(SPONSOR_COLUMNS).order("created_at", { ascending: true });
  return ((data ?? []) as unknown[]).map(parseSponsor).filter((s): s is DfySponsor => s !== null);
}

export interface SponsorReport {
  sponsorId: string;
  code: string;
  name: string;
  /** Matters ever opened under this sponsor (all statuses). */
  total: number;
  /** Suppressed (null) below the floor. */
  byStatus: Record<string, number> | null;
  byDetermination: Record<string, number> | null;
  suppressed: boolean;
  k: number;
}

/** Pure: fold engagement rows into the aggregate report with k-anon suppression. */
export function buildSponsorReport(
  sponsor: DfySponsor,
  rows: Array<{ status: string; determination: string | null }>,
  k: number = SPONSOR_REPORT_K,
): SponsorReport {
  const total = rows.length;
  if (total < k) {
    return { sponsorId: sponsor.id, code: sponsor.code, name: sponsor.name, total: 0, byStatus: null, byDetermination: null, suppressed: true, k };
  }
  const byStatus: Record<string, number> = {};
  const byDetermination: Record<string, number> = {};
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (r.determination) byDetermination[r.determination] = (byDetermination[r.determination] ?? 0) + 1;
  }
  // Every published cell must itself clear the floor, or it is folded into "other".
  const fold = (m: Record<string, number>): Record<string, number> => {
    const out: Record<string, number> = {};
    let other = 0;
    for (const [key, n] of Object.entries(m)) {
      if (n >= k) out[key] = n; else other += n;
    }
    if (other > 0) out.other = other;
    return out;
  };
  return { sponsorId: sponsor.id, code: sponsor.code, name: sponsor.name, total, byStatus: fold(byStatus), byDetermination: fold(byDetermination), suppressed: false, k };
}

/** The sponsor's matters, read as rows of (status, determination) ONLY — never member data. */
export async function loadSponsorReport(supabase: SupabaseClient, sponsor: DfySponsor): Promise<SponsorReport> {
  return buildSponsorReport(sponsor, await listSponsorReportRows(supabase, sponsor.id));
}
