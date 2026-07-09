import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin/require-admin";
import { logAdminAction } from "@/lib/admin/audit-log";

/**
 * POST /api/admin/services/merge
 * Body: { canonicalServiceId: string, mergeServiceIds: string[] }
 * Merges duplicate services into one canonical service.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return admin.response;

  const { canonicalServiceId, mergeServiceIds } = await req.json();
  if (!canonicalServiceId || !mergeServiceIds?.length) {
    return NextResponse.json({ error: "canonicalServiceId and mergeServiceIds required" }, { status: 400 });
  }

  const supabase = createServerClient();
  const results: { serviceId: string; slug: string; movedRows: number; deletedDupes: number }[] = [];

  try {
    // Load canonical service
    const { data: canonical } = await supabase
      .from("service_catalog")
      .select("id, slug, concept_id")
      .eq("id", canonicalServiceId)
      .single();

    if (!canonical) {
      return NextResponse.json({ error: "Canonical service not found" }, { status: 404 });
    }

    for (const mergeId of mergeServiceIds) {
      if (mergeId === canonicalServiceId) continue;

      const { data: mergeService } = await supabase
        .from("service_catalog")
        .select("id, slug, concept_id")
        .eq("id", mergeId)
        .single();

      if (!mergeService) continue;

      let movedRows = 0;
      let deletedDupes = 0;

      // ── 1. Migrate plan_covered_services ──────────────────────────────

      const { data: mergeRows } = await supabase
        .from("plan_covered_services")
        .select("id, insurance_plan_id, place_of_service, confidence")
        .eq("service_id", mergeId);

      for (const row of mergeRows || []) {
        // Check if canonical already has a row for this plan + place_of_service
        const { data: existing } = await supabase
          .from("plan_covered_services")
          .select("id, confidence")
          .eq("insurance_plan_id", row.insurance_plan_id)
          .eq("service_id", canonicalServiceId)
          .eq("place_of_service", row.place_of_service)
          .maybeSingle();

        if (existing) {
          // Conflict: keep the one with higher confidence
          const keepExisting = (existing.confidence || 0) >= (row.confidence || 0);
          if (keepExisting) {
            await supabase.from("plan_covered_services").delete().eq("id", row.id);
          } else {
            await supabase.from("plan_covered_services").delete().eq("id", existing.id);
            await supabase.from("plan_covered_services").update({ service_id: canonicalServiceId }).eq("id", row.id);
          }
          deletedDupes++;
        } else {
          // No conflict: just re-point
          await supabase.from("plan_covered_services").update({ service_id: canonicalServiceId }).eq("id", row.id);
          movedRows++;
        }
      }

      // ── 2. Migrate claim_insights ─────────────────────────────────────

      const { data: insightRows } = await supabase
        .from("claim_insights")
        .select("id, insurer_name")
        .eq("service_id", mergeId);

      for (const row of insightRows || []) {
        const { data: existing } = await supabase
          .from("claim_insights")
          .select("id")
          .eq("service_id", canonicalServiceId)
          .eq("insurer_name", row.insurer_name)
          .maybeSingle();

        if (existing) {
          await supabase.from("claim_insights").delete().eq("id", row.id);
        } else {
          await supabase.from("claim_insights").update({ service_id: canonicalServiceId }).eq("id", row.id);
        }
      }

      // ── 3. Update concept graph ───────────────────────────────────────

      if (mergeService.concept_id && canonical.concept_id) {
        // Record the merge relationship
        await supabase.from("concept_relationships").insert({
          concept_id_1: mergeService.concept_id,
          concept_id_2: canonical.concept_id,
          relationship_type: "merged_with",
        });
        // Mark deprecated concept as inactive
        await supabase.from("concepts").update({ is_active: false }).eq("id", mergeService.concept_id);
      }

      // ── 4. Mark service as merged ─────────────────────────────────────

      await supabase.from("service_catalog").update({
        merged_into_id: canonicalServiceId,
        merged_at: new Date().toISOString(),
      }).eq("id", mergeId);

      results.push({
        serviceId: mergeId,
        slug: mergeService.slug,
        movedRows,
        deletedDupes,
      });
    }

    await logAdminAction({
      adminUserId: admin.adminUserId,
      adminEmail: admin.adminEmail,
      action: "service_merge",
      targetTable: "service_catalog",
      details: `Merged ${results.map(r => r.slug).join(", ")} into ${canonical.slug}. Total moved: ${results.reduce((a, r) => a + r.movedRows, 0)}, deduped: ${results.reduce((a, r) => a + r.deletedDupes, 0)}`,
      ipAddress: req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip"),
    });

    return NextResponse.json({
      success: true,
      canonicalSlug: canonical.slug,
      merged: results,
    });
  } catch (err) {
    console.error("[admin/services/merge] Error:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Merge failed" }, { status: 500 });
  }
}
