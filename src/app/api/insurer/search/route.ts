/**
 * GET /api/insurer/search — S111 D4.
 *
 * Insurer typeahead for PlanSearchModal's insurer chip / autocomplete. Returns
 * up to 10 matches from `insurer_catalog` filtered by ilike `%q%` on `name`.
 *
 * Why dynamic (no hardcoded list): the insurer roster grows as cold-start
 * ingest + organic onboarding add carriers, AND we already maintain
 * `insurer_catalog` as the canonical source for /api/plan/search,
 * resolveInsurer in plan-context.ts, and the dispute letter recipient block.
 * A hardcoded list would drift and require manual updates per carrier added.
 *
 * Auth: Firebase bearer token — consistent with /api/plan/search.
 *
 * Query params:
 *   - q (string, required) — typed text. Empty / sub-2-char returns [].
 *
 * Response: `{ insurers: { id: string; name: string }[] }` (max 10 entries).
 *
 * Pattern 1 #2 alignment: read-only against canonical reference data; no
 * write authority. Pattern 1 #4 — name is the only field exposed (no
 * appeals address / phone) since this powers a search-time disambiguator,
 * not a citation surface.
 */
import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

const MAX_RESULTS = 10;
const MIN_QUERY_LENGTH = 2;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") ?? "").trim();
  if (q.length < MIN_QUERY_LENGTH) {
    return NextResponse.json({ insurers: [] });
  }

  // Escape ILIKE wildcards so literal "%" or "_" in user input don't widen
  // the pattern beyond what was typed. Mirrors /api/plan/search escape.
  const escaped = q.replace(/[\\%_]/g, (m) => `\\${m}`);

  const supabase = createServerClient();
  const { data: rows, error } = await supabase
    .from("insurer_catalog")
    .select("id, name")
    .ilike("name", `%${escaped}%`)
    .order("name", { ascending: true })
    .limit(MAX_RESULTS * 2); // overfetch slightly so ranking has room

  if (error || !rows) {
    return NextResponse.json({ insurers: [] });
  }

  // Rank: prefix matches first, then alphabetical. Keeps the dropdown
  // intuitive when many catalog rows match a short query (e.g. "Blue" hits
  // every BCBS regional licensee).
  const lowerQ = q.toLowerCase();
  const ranked = (rows as Array<{ id: string; name: string }>)
    .map((r) => ({
      row: r,
      startsWith: r.name.toLowerCase().startsWith(lowerQ) ? 0 : 1,
    }))
    .sort((a, b) => {
      if (a.startsWith !== b.startsWith) return a.startsWith - b.startsWith;
      return a.row.name.localeCompare(b.row.name);
    })
    .slice(0, MAX_RESULTS)
    .map(({ row }) => ({ id: row.id, name: row.name }));

  return NextResponse.json({ insurers: ranked });
}
