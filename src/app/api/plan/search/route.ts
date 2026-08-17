import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

/**
 * POST /api/plan/search — autocomplete for the /compare slot picker.
 *
 * S107 follow-up: source of truth is now `canonical_plans` (not `plan_catalog`).
 *
 * Why the swap: `plan_catalog_canonical_map` is the bridge between the CMS-
 * ingested plan_catalog rows and our canonical plan_plans rows. That bridge is
 * empty in PROD (S107 diagnostic: 2,275 catalog rows · 0 mapped). Every search
 * hit from plan_catalog therefore landed in /compare as an unresolvable ref +
 * silently dropped below the 2-plan threshold. Switching the search source to
 * canonical_plans makes "shown in search" = "comparable" by construction.
 *
 * Each result carries a `badgeLevel` derived from canonical_plans.field_provenance
 * + source_count + is_verified, mapped to Pattern 1 #16 vocabulary:
 *   - "verified"   — canonical fully promoted (is_verified=true) OR admin-attested
 *                    (any field_provenance entry with source='admin_attested').
 *   - "community"  — source_count ≥ 2 (multi-source aggregation, pre-promotion).
 *   - "estimated"  — source_count ≤ 1 (single-source, awaiting corroboration).
 *
 * Pattern 2 identity matching (used during user SBC upload) STILL queries
 * plan_catalog via src/lib/plan/matcher.ts — this swap does NOT touch that path.
 * CMS ingest (cms-marketplace-ingest.ts) also continues writing plan_catalog
 * untouched; we just stop reading it from search.
 */

interface PlanSearchResultBadgeLevel {
  level: "verified" | "community" | "estimated";
}

interface FieldProvenanceEntry {
  source?: unknown;
}

function deriveBadgeLevel(
  fieldProvenance: unknown,
  sourceCount: number | null,
  isVerified: boolean | null,
): PlanSearchResultBadgeLevel["level"] {
  if (isVerified === true) return "verified";

  // Admin-attested cold-start plans set source='admin_attested' on every field
  // they populate via mig 111's apply_promotion_event(force_event_type='admin_override').
  // Any one such field is enough to mark the whole canonical as Verified.
  if (fieldProvenance && typeof fieldProvenance === "object") {
    const provenance = fieldProvenance as Record<string, FieldProvenanceEntry>;
    for (const key of Object.keys(provenance)) {
      const entry = provenance[key];
      if (
        entry &&
        typeof entry === "object" &&
        (entry.source === "admin_attested" || entry.source === "candid_verified")
      ) {
        return "verified";
      }
    }
  }

  if ((sourceCount ?? 0) >= 2) return "community";
  return "estimated";
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { query, state, planType, metalLevel, planYear, insurerHint, canonicalOnly, limit } = await req.json();
  // S315 (Andrew): EVERY search surface returns the full match set — all
  // consumers render scrollable containers and show a count line past 25.
  // `limit` remains honored for any caller that wants fewer; 500 is the
  // safety clamp (the whole library is ~1.3k rows; a 2-char query tokenized
  // AND-wise rarely exceeds a few hundred).
  const resultLimit = Math.min(500, Math.max(1, typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : 500));
  void canonicalOnly; // S110 Chunk D — accepted for forward-compat; this route IS canonical-only

  if (!query || typeof query !== "string" || query.trim().length < 2) {
    return NextResponse.json({ plans: [] });
  }

  const trimmed = query.trim();
  const supabase = createServerClient();

  // Tokenize on whitespace and AND each token as its own ILIKE (below) so a
  // multi-word query matches names where the words are non-contiguous or out of
  // order — e.g. "kaiser go" → "Kaiser Permanente - Gold 80 HMO". A single
  // ILIKE on the whole string only matches a contiguous substring, so it
  // silently returned zero results the moment a user typed past the first word.
  // Each token escapes SQL ILIKE wildcards so user input ("100%") can't widen
  // the pattern.
  const tokens = trimmed
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/[\\%_]/g, (m) => `\\${m}`));

  // S110 Chunk D — when insurerHint provided, pre-resolve matching insurer ids
  // from insurer_catalog so canonical_plans.insurer_id can be filtered. Empty
  // match → zero results (false negative preferred over false positive).
  let insurerIdFilter: string[] | null = null;
  if (typeof insurerHint === "string" && insurerHint.trim().length >= 2) {
    const insurerEscaped = insurerHint.trim().replace(/[\\%_]/g, (m) => `\\${m}`);
    const { data: insurerMatches } = await supabase
      .from("insurer_catalog")
      .select("id")
      .ilike("name", `%${insurerEscaped}%`)
      .limit(20);
    insurerIdFilter = (insurerMatches ?? []).map((r) => r.id as string);
    if (insurerIdFilter.length === 0) {
      return NextResponse.json({ plans: [] });
    }
  }

  let queryBuilder = supabase
    .from("canonical_plans")
    .select(
      `id,
       hios_id,
       plan_name,
       plan_type,
       state,
       plan_year,
       metal_level,
       premium_monthly,
       deductible_individual,
       oop_max_individual,
       insurer_id,
       confidence_score,
       source_count,
       is_verified,
       field_provenance`,
    )
    .limit(1000);

  // AND every token: each .ilike() chains as a separate AND condition, so all
  // words must appear somewhere in plan_name (order-independent).
  for (const tok of tokens) {
    queryBuilder = queryBuilder.ilike("plan_name", `%${tok}%`);
  }

  if (state && typeof state === "string") queryBuilder = queryBuilder.eq("state", state);
  if (planType && typeof planType === "string") queryBuilder = queryBuilder.eq("plan_type", planType);
  if (metalLevel && typeof metalLevel === "string") {
    queryBuilder = queryBuilder.eq("metal_level", metalLevel.toLowerCase());
  }
  // S110 Chunk D — bill-year filter for SearchCanonicalPlanModal.
  if (typeof planYear === "number" && Number.isFinite(planYear)) {
    queryBuilder = queryBuilder.eq("plan_year", planYear);
  }
  if (insurerIdFilter) {
    queryBuilder = queryBuilder.in("insurer_id", insurerIdFilter);
  }

  const { data: rows, error } = await queryBuilder;
  if (error || !rows) {
    return NextResponse.json({ plans: [] });
  }

  // Hydrate insurer display names (parallel join — Supabase client can't do
  // arbitrary joins without a foreign-key relationship declaration, and the
  // existing schema route doesn't have one declared for this pair).
  const insurerIds = [
    ...new Set(rows.map((r) => r.insurer_id).filter(Boolean)),
  ] as string[];
  const insurerNameMap = new Map<string, string>();
  if (insurerIds.length > 0) {
    const { data: insurers } = await supabase
      .from("insurer_catalog")
      .select("id, name")
      .in("id", insurerIds);
    if (insurers) {
      for (const ins of insurers) insurerNameMap.set(ins.id, ins.name);
    }
  }

  // Rank: prefix matches first, then verified/community/estimated, then
  // alphabetical. Keeps the dropdown intuitive when 30+ rows come back.
  const lowerQ = trimmed.toLowerCase();
  const ranked = rows
    .map((r) => {
      const badgeLevel = deriveBadgeLevel(
        r.field_provenance,
        r.source_count as number | null,
        r.is_verified as boolean | null,
      );
      const lowerName = (r.plan_name || "").toLowerCase();
      const startsWith = lowerName.startsWith(lowerQ) ? 0 : 1;
      const badgeRank =
        badgeLevel === "verified" ? 0 : badgeLevel === "community" ? 1 : 2;
      return { row: r, badgeLevel, startsWith, badgeRank };
    })
    .sort((a, b) => {
      if (a.startsWith !== b.startsWith) return a.startsWith - b.startsWith;
      if (a.badgeRank !== b.badgeRank) return a.badgeRank - b.badgeRank;
      return (a.row.plan_name || "").localeCompare(b.row.plan_name || "");
    });
  const totalMatches = ranked.length;
  const limited = ranked.slice(0, resultLimit);

  const results = limited.map(({ row, badgeLevel }) => ({
    // S107: id IS the canonical_plan_id now (no plan_catalog indirection).
    // We keep both keys populated so /compare client code continues to read
    // `s.selected.canonicalPlanId` without any change.
    id: row.id as string,
    canonicalPlanId: row.id as string,
    hiosId: row.hios_id as string | null,
    name: row.plan_name as string,
    type: row.plan_type as string | null,
    state: row.state as string | null,
    metalLevel: row.metal_level as string | null,
    premium: row.premium_monthly as number | null,
    deductible: row.deductible_individual as number | null,
    oopMax: row.oop_max_individual as number | null,
    year: row.plan_year as number | null,
    confidence: row.confidence_score as number | null,
    badgeLevel,
    insurerName: insurerNameMap.get((row.insurer_id as string) ?? "") ?? "",
  }));

  return NextResponse.json({ plans: results, total: totalMatches });
}
