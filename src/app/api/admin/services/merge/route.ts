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
  const mergeFailures: { serviceId: string; slug: string; failures: string[] }[] = [];

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
      // S289 — every mutation below is error-checked; ANY failure stops this
      // service's remaining steps BEFORE the mark-merged stamp (step 4), so a
      // partially-migrated service is never marked merged. Re-running the
      // merge picks up exactly where it stopped (every step is idempotent:
      // already-moved rows no longer match their source queries).
      const failures: string[] = [];
      const ok = (label: string, error: { message: string } | null): boolean => {
        if (error) failures.push(`${label}: ${error.message}`);
        return !error;
      };

      // ── 1. Migrate plan_covered_services ──────────────────────────────
      // Row identity = the FULL uq_plan_covered_service key (mig 195):
      // (insurance_plan_id, service_id, place_of_service, component,
      // plan_tier_label). The pre-S289 lookup matched only 3 of those cols —
      // on multi-variant services (facility vs professional component, drug
      // tier buckets) maybeSingle() errored unread, the "no conflict" branch
      // re-pointed straight into the UNIQUE constraint, the update failed
      // silently, and the row stayed on the merged service forever (readers
      // filter merged services → coverage silently vanished).

      const { data: mergeRows, error: mergeRowsErr } = await supabase
        .from("plan_covered_services")
        .select("id, insurance_plan_id, place_of_service, component, plan_tier_label, confidence")
        .eq("service_id", mergeId);
      ok("pcs load", mergeRowsErr);

      if (failures.length === 0) {
        for (const row of mergeRows || []) {
          const { data: existing, error: existingErr } = await supabase
            .from("plan_covered_services")
            .select("id, confidence")
            .eq("insurance_plan_id", row.insurance_plan_id)
            .eq("service_id", canonicalServiceId)
            .eq("place_of_service", row.place_of_service)
            .eq("component", row.component)
            .eq("plan_tier_label", row.plan_tier_label)
            .maybeSingle(); // ≤1 guaranteed by uq_plan_covered_service
          if (!ok(`pcs incumbent lookup (row ${row.id})`, existingErr)) break;

          if (existing) {
            // Full-key conflict: keep the higher-confidence extraction. (pcs
            // rows are per-user parses ranked by confidence — deliberately
            // different from the canonical step below, where the corroborated
            // incumbent wins.)
            const keepExisting = (existing.confidence || 0) >= (row.confidence || 0);
            if (keepExisting) {
              const { error } = await supabase.from("plan_covered_services").delete().eq("id", row.id);
              if (!ok(`pcs dedupe delete (row ${row.id})`, error)) break;
            } else {
              const { error: delErr } = await supabase.from("plan_covered_services").delete().eq("id", existing.id);
              if (!ok(`pcs incumbent delete (row ${existing.id})`, delErr)) break;
              const { error: updErr } = await supabase
                .from("plan_covered_services")
                .update({ service_id: canonicalServiceId })
                .eq("id", row.id);
              if (!ok(`pcs re-point (row ${row.id})`, updErr)) break;
            }
            deletedDupes++;
          } else {
            const { error } = await supabase
              .from("plan_covered_services")
              .update({ service_id: canonicalServiceId })
              .eq("id", row.id);
            if (!ok(`pcs re-point (row ${row.id})`, error)) break;
            movedRows++;
          }
        }
      }

      // ── 1.5 Migrate canonical_plan_services (S289) ────────────────────
      // cps stores service_slug TEXT (FK added mig 213) — this step was
      // simply missing: a merge re-pointed user coverage + claim_insights but
      // stranded canonical rows on the dead slug forever. Policy matches mig
      // 213 step 1: INCUMBENT WINS on a 5-col-key collision (single-statement
      // DELETE of the mover — no delete-then-update window); otherwise a
      // single-statement UPDATE re-slugs the row (the mig-213 stamp trigger
      // re-derives concept_id on the slug change).

      if (failures.length === 0) {
        const { data: canonicalRows, error: canonicalRowsErr } = await supabase
          .from("canonical_plan_services")
          .select("id, canonical_plan_id, place_of_service, component, plan_tier_label")
          .eq("service_slug", mergeService.slug);
        ok("cps load", canonicalRowsErr);

        for (const row of failures.length ? [] : canonicalRows || []) {
          const { data: incumbent, error: incumbentErr } = await supabase
            .from("canonical_plan_services")
            .select("id")
            .eq("canonical_plan_id", row.canonical_plan_id)
            .eq("service_slug", canonical.slug)
            .eq("place_of_service", row.place_of_service)
            .eq("component", row.component)
            .eq("plan_tier_label", row.plan_tier_label)
            .maybeSingle();
          if (!ok(`cps incumbent lookup (row ${row.id})`, incumbentErr)) break;

          if (incumbent) {
            const { error } = await supabase.from("canonical_plan_services").delete().eq("id", row.id);
            if (!ok(`cps dedupe delete (row ${row.id})`, error)) break;
            deletedDupes++;
          } else {
            const { error } = await supabase
              .from("canonical_plan_services")
              .update({ service_slug: canonical.slug })
              .eq("id", row.id);
            if (!ok(`cps re-slug (row ${row.id})`, error)) break;
            movedRows++;
          }
        }
      }

      // ── 2. Migrate claim_insights ─────────────────────────────────────

      if (failures.length === 0) {
        const { data: insightRows, error: insightRowsErr } = await supabase
          .from("claim_insights")
          .select("id, insurer_name")
          .eq("service_id", mergeId);
        ok("claim_insights load", insightRowsErr);

        for (const row of failures.length ? [] : insightRows || []) {
          const { data: existing, error: existingErr } = await supabase
            .from("claim_insights")
            .select("id")
            .eq("service_id", canonicalServiceId)
            .eq("insurer_name", row.insurer_name)
            .maybeSingle();
          if (!ok(`claim_insights lookup (row ${row.id})`, existingErr)) break;

          if (existing) {
            const { error } = await supabase.from("claim_insights").delete().eq("id", row.id);
            if (!ok(`claim_insights dedupe delete (row ${row.id})`, error)) break;
          } else {
            const { error } = await supabase.from("claim_insights").update({ service_id: canonicalServiceId }).eq("id", row.id);
            if (!ok(`claim_insights re-point (row ${row.id})`, error)) break;
          }
        }
      }

      // ── 3. Update concept graph ───────────────────────────────────────

      if (failures.length === 0 && mergeService.concept_id && canonical.concept_id) {
        // Record the merge relationship. A duplicate-key error here means a
        // prior partial run already recorded it — benign on re-run, not a
        // failure.
        const { error: relErr } = await supabase.from("concept_relationships").insert({
          concept_id_1: mergeService.concept_id,
          concept_id_2: canonical.concept_id,
          relationship_type: "merged_with",
        });
        if (relErr && !/duplicate key/i.test(relErr.message)) {
          failures.push(`concept relationship: ${relErr.message}`);
        }
        // Mark deprecated concept as inactive
        const { error: conErr } = await supabase.from("concepts").update({ is_active: false }).eq("id", mergeService.concept_id);
        ok("concept deactivate", conErr);
      }

      // ── 4. Mark service as merged — ONLY when steps 1-3 fully succeeded ──
      // (A merged_into_id stamp on a partially-migrated service would hide
      // its stranded rows from every reader with no way to notice.)

      if (failures.length === 0) {
        const { error } = await supabase.from("service_catalog").update({
          merged_into_id: canonicalServiceId,
          merged_at: new Date().toISOString(),
        }).eq("id", mergeId);
        ok("mark merged", error);
      }

      if (failures.length > 0) {
        mergeFailures.push({ serviceId: mergeId, slug: mergeService.slug, failures });
        continue; // this service is re-runnable; carry on with the rest
      }

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
      details: `Merged ${results.map(r => r.slug).join(", ")} into ${canonical.slug}. Total moved: ${results.reduce((a, r) => a + r.movedRows, 0)}, deduped: ${results.reduce((a, r) => a + r.deletedDupes, 0)}${mergeFailures.length ? `. FAILED (not marked merged): ${mergeFailures.map(f => `${f.slug} [${f.failures.join("; ")}]`).join(", ")}` : ""}`,
      ipAddress: req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip"),
    });

    if (mergeFailures.length > 0) {
      return NextResponse.json(
        {
          success: false,
          canonicalSlug: canonical.slug,
          merged: results,
          failed: mergeFailures,
          error: `${mergeFailures.length} service(s) failed mid-merge and were NOT marked merged — fix the cause and re-run the merge for them.`,
        },
        { status: 500 },
      );
    }

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
