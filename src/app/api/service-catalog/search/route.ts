/**
 * POST /api/service-catalog/search — S153 synonym-aware service search.
 *
 * Replaces the client-side substring filter in CategoryCorrectionModal with
 * server-side ranking: trigram over slug/name + learned-synonym hits
 * (billing_code_mappings signature rows) + (on explicit `semantic:true`) a
 * single budget-gated Haiku resolve that ALSO learns the synonym so the next
 * identical search is instant. So "wellness" → preventive_care even though the
 * strings don't overlap.
 *
 * Auth: Firebase bearer (the semantic path can spend Haiku → needs a user for
 * the per-user-day budget cap). When service_resolver_v1 is OFF, returns the
 * full catalog unranked so the modal's legacy client filter still works.
 *
 * Body: { query: string, semantic?: boolean, limit?: number }
 * Returns: { items: Array<{ slug, name, category, description, score, source }> }
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { isFeatureEnabled } from "@/lib/config/product-flags";

async function getDbUserId(req: NextRequest): Promise<string | null> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    const supabase = createServerClient();
    const { data } = await supabase
      .from("users")
      .select("id")
      .eq("firebase_uid", decoded.uid)
      .maybeSingle();
    return (data?.id as string | null) ?? null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const userId = await getDbUserId(req);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { query?: unknown; semantic?: unknown; limit?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const semantic = body.semantic === true;
  const limit =
    typeof body.limit === "number" && body.limit > 0 && body.limit <= 50
      ? Math.floor(body.limit)
      : 20;

  if (query.length < 2) {
    return NextResponse.json({ items: [] });
  }

  const supabase = createServerClient();
  const resolverEnabled = await isFeatureEnabled("service_resolver_v1");

  // Flag OFF — server-side substring filter (equivalent to the legacy client
  // filter) so the modal can always consume server results regardless of flag.
  if (!resolverEnabled) {
    const { data } = await supabase
      .from("service_catalog")
      .select("slug, name, category, description")
      .is("merged_into_id", null)
      .order("category", { ascending: true })
      .order("name", { ascending: true });
    const ql = query.toLowerCase();
    const qSlug = ql.replace(/\s+/g, "_");
    const items = (data ?? [])
      .filter(
        (r) =>
          (r.slug as string).includes(qSlug) ||
          ((r.name as string) ?? "").toLowerCase().includes(ql) ||
          ((r.category as string) ?? "").toLowerCase().includes(ql),
      )
      .slice(0, limit)
      .map((r) => ({ ...r, score: 0, source: "name" as const }));
    return NextResponse.json({ items });
  }

  const { searchServices } = await import("@/lib/claims/service-resolver");
  const results = await searchServices(query, {
    supabase,
    userId,
    limit,
    // Per-keystroke calls pass semantic=false → instant trigram + synonym only.
    // The "search smarter" / no-results path passes semantic=true → one
    // budget-gated Haiku resolve that learns the synonym for next time.
    skipHaiku: !semantic,
  });

  return NextResponse.json({
    items: results.map((r) => ({
      slug: r.slug,
      name: r.name,
      category: r.category,
      description: r.description,
      score: Math.round(r.score * 100) / 100,
      source: r.source,
    })),
  });
}
