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

  const { query, state, planType, metalLevel } = await req.json();

  if (!query || typeof query !== "string" || query.trim().length < 2) {
    return NextResponse.json({ plans: [] });
  }

  const trimmed = query.trim();
  const supabase = createServerClient();

  // Escape SQL ILIKE wildcards so user input doesn't widen the pattern beyond
  // the typed text. (e.g. "100%" should match the literal characters, not
  // every plan name.)
  const escaped = trimmed.replace(/[\\%_]/g, (m) => `\\${m}`);

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
    .ilike("plan_name", `%${escaped}%`)
    .limit(50);

  if (state && typeof state === "string") queryBuilder = queryBuilder.eq("state", state);
  if (planType && typeof planType === "string") queryBuilder = queryBuilder.eq("plan_type", planType);
  if (metalLevel && typeof metalLevel === "string") {
    queryBuilder = queryBuilder.eq("metal_level", metalLevel.toLowerCase());
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
    })
    .slice(0, 15);

  const results = ranked.map(({ row, badgeLevel }) => ({
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

  return NextResponse.json({ plans: results });
}
