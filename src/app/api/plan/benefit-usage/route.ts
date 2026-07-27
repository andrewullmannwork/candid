import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/security/require-authenticated-user";
import { userScoped } from "@/lib/security/user-scoped";
import { loadCatalogIdentity } from "@/lib/plan/catalog-identity";
import {
  applyUsedBenefitsToggle,
  readUsedBenefits,
  USED_BENEFITS_CAP,
} from "@/lib/plan/benefit-usage";

/**
 * POST /api/plan/benefit-usage — persist "I use this benefit" ticks (S289).
 * Body: { add?: string[], remove?: string[] } (service slugs).
 *
 * Writes metadata.used_benefits on the user's ACTIVE insurance_plans row
 * (see src/lib/plan/benefit-usage.ts for why that placement). Adds are
 * validated against service_catalog and normalized to LIVE slugs via the
 * merge-chain resolver — an unknown slug is a 400, not a silent drop.
 * 404 = no active plan row (profile-only accounts have nowhere to persist;
 * the client keeps such ticks session-local).
 */
export async function POST(request: NextRequest) {
  try {
    const authedUser = await requireAuthenticatedUser(request);
    if (!authedUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = authedUser.id;

    let body: { add?: unknown; remove?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const asSlugList = (v: unknown): string[] | null => {
      if (v === undefined) return [];
      if (!Array.isArray(v)) return null;
      if (!v.every((s) => typeof s === "string" && s.length > 0 && s.length <= 100)) return null;
      return v as string[];
    };
    const add = asSlugList(body.add);
    const remove = asSlugList(body.remove);
    if (add === null || remove === null) {
      return NextResponse.json(
        { error: "add/remove must be arrays of service slugs" },
        { status: 400 },
      );
    }
    if (add.length === 0 && remove.length === 0) {
      return NextResponse.json({ error: "Nothing to do" }, { status: 400 });
    }
    if (add.length + remove.length > USED_BENEFITS_CAP) {
      return NextResponse.json({ error: "Too many slugs" }, { status: 400 });
    }

    const supabase = createServerClient();

    // Normalize adds to LIVE catalog slugs; unknown slugs fail loud (a tick
    // references a benefit we rendered — if it doesn't resolve, something
    // upstream is wrong and silently storing it would hide that).
    const identity = await loadCatalogIdentity(supabase, [...add, ...remove]);
    const unknownAdds = add.filter((s) => !identity.has(s));
    if (unknownAdds.length > 0) {
      return NextResponse.json(
        { error: `Unknown service slug(s): ${unknownAdds.join(", ")}` },
        { status: 400 },
      );
    }
    const liveAdds = add.map((s) => identity.get(s)!.liveSlug);
    // Removes clear every known form — the verbatim slug plus its live twin —
    // so ticks stored before a catalog merge still clear.
    const removeAll = remove.flatMap((s) => {
      const live = identity.get(s)?.liveSlug;
      return live && live !== s ? [s, live] : [s];
    });

    const { data: activePlan, error: planErr } = await userScoped(supabase, userId)
      .table("insurance_plans")
      .select("id, metadata")
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (planErr) {
      console.error("[benefit-usage] active-plan read failed:", planErr.message);
      return NextResponse.json({ error: "Plan lookup failed" }, { status: 500 });
    }
    if (!activePlan) {
      return NextResponse.json({ error: "No active plan to persist against" }, { status: 404 });
    }

    const nextUsed = applyUsedBenefitsToggle(activePlan.metadata, {
      add: liveAdds,
      remove: removeAll,
    });
    const nextMetadata = {
      ...((activePlan.metadata as Record<string, unknown> | null) ?? {}),
      used_benefits: nextUsed,
    };
    const { error: updateErr } = await userScoped(supabase, userId)
      .table("insurance_plans")
      .update({ metadata: nextMetadata })
      .eq("id", activePlan.id);
    if (updateErr) {
      console.error("[benefit-usage] metadata update failed:", updateErr.message);
      return NextResponse.json({ error: "Save failed" }, { status: 500 });
    }

    return NextResponse.json({ usedBenefits: nextUsed });
  } catch (err) {
    console.error("[benefit-usage] error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

/**
 * GET — current ticks for the active plan. The /plan + /dashboard pages
 * hydrate from the analyze response (which carries the same array); this
 * exists for consumers that don't need a full analyze.
 */
export async function GET(request: NextRequest) {
  try {
    const authedUser = await requireAuthenticatedUser(request);
    if (!authedUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const supabase = createServerClient();
    const { data: activePlan } = await userScoped(supabase, authedUser.id)
      .table("insurance_plans")
      .select("id, metadata")
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return NextResponse.json({
      usedBenefits: activePlan ? readUsedBenefits(activePlan.metadata) : [],
    });
  } catch (err) {
    console.error("[benefit-usage] error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
