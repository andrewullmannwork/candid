/**
 * POST /api/plan/corrections — Submit or manage benefit corrections
 *
 * Actions:
 *   - submit: User flags an incorrect benefit value
 *   - review: Admin approves/rejects a correction
 *   - apply: Admin applies an approved correction to the canonical plan
 *
 * GET /api/plan/corrections — List corrections (admin: all pending, user: own)
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped, adminScoped } from "@/lib/security/user-scoped";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import type { CorrectionField } from "@/lib/supabase/types";
import { applyPromotionEvent } from "@/lib/parser/promotion-event";
import { coerceComponent, type CoverageComponent } from "@/lib/plan/coverage-targeting";

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

/** GET — list corrections */
export async function GET(req: NextRequest) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();
  const { data: internalUser } = await supabase
    .from("users")
    .select("id, is_admin, email")
    .eq("firebase_uid", decoded.uid)
    .single();

  if (!internalUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const isAdmin = internalUser.is_admin === true;
  const status = req.nextUrl.searchParams.get("status") || "pending";

  // B9 B1.2 — a non-admin reads only their own corrections (userScoped injects
  // .eq("user_id")); an admin reads the cross-user review queue (adminScoped
  // re-verifies is_admin and is intentionally un-scoped). Op-equivalent to the
  // prior single query with its branch filter.
  const adminClient = isAdmin ? await adminScoped(supabase, internalUser.id) : null;
  let query = (
    adminClient
      ? adminClient.table("benefit_corrections").select("*")
      : userScoped(supabase, internalUser.id).table("benefit_corrections").select("*")
  )
    .order("created_at", { ascending: false })
    .limit(100);
  if (adminClient && status !== "all") {
    query = query.eq("status", status);
  }

  const { data, error } = await query;

  if (error) {
    console.error("[corrections] List error:", error);
    return NextResponse.json({ error: "Failed to list corrections" }, { status: 500 });
  }

  return NextResponse.json({ corrections: data || [] });
}

/** POST — submit, review, or apply corrections */
export async function POST(req: NextRequest) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();
  const { data: internalUser } = await supabase
    .from("users")
    .select("id, is_admin, email")
    .eq("firebase_uid", decoded.uid)
    .single();

  if (!internalUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const body = await req.json();
  const { action } = body;

  // ── Submit a new correction ────────────────────────────────────────────
  if (action === "submit") {
    const flagEnabled = await isFeatureEnabled("benefit_corrections", internalUser.email || undefined);
    if (!flagEnabled) {
      return NextResponse.json({ error: "Benefit corrections are not enabled" }, { status: 403 });
    }
    const { serviceSlug, field, oldValue, proposedValue, notes, insurancePlanId, canonicalPlanId } = body as {
      serviceSlug: string;
      field: CorrectionField;
      oldValue?: string;
      proposedValue: string;
      notes?: string;
      insurancePlanId?: string;
      canonicalPlanId?: string;
    };

    if (!serviceSlug || !field || !proposedValue) {
      return NextResponse.json({ error: "serviceSlug, field, and proposedValue are required" }, { status: 400 });
    }

    // B9 B1.2 — userScoped stamps user_id (op-equivalent to the prior explicit value).
    const { data: correction, error } = await userScoped(supabase, internalUser.id)
      .table("benefit_corrections")
      .insert({
        insurance_plan_id: insurancePlanId || null,
        canonical_plan_id: canonicalPlanId || null,
        service_slug: serviceSlug,
        field,
        old_value: oldValue || null,
        proposed_value: proposedValue,
        notes: notes || null,
      })
      .select("id")
      .single();

    if (error) {
      console.error("[corrections] Submit error:", error);
      return NextResponse.json({ error: "Failed to submit correction" }, { status: 500 });
    }

    // Notify admin via Slack
    try {
      const { notifyBenefitCorrection } = await import("@/lib/notifications");
      await notifyBenefitCorrection(serviceSlug, field, proposedValue, internalUser.email || undefined);
    } catch { /* non-critical */ }

    return NextResponse.json({ success: true, correctionId: correction.id });
  }

  // ── Admin: review a correction ─────────────────────────────────────────
  if (action === "review") {
    if (internalUser.is_admin !== true) {
      return NextResponse.json({ error: "Admin only" }, { status: 403 });
    }

    const { correctionId, decision, reviewNotes } = body as {
      correctionId: string;
      decision: "approved" | "rejected";
      reviewNotes?: string;
    };

    if (!correctionId || !decision) {
      return NextResponse.json({ error: "correctionId and decision required" }, { status: 400 });
    }

    // B9 B1.2 — admin-authority cross-user update (is_admin verified above; adminScoped re-verifies).
    const admin = await adminScoped(supabase, internalUser.id);
    const { error } = await admin
      .table("benefit_corrections")
      .update({
        status: decision,
        reviewed_by: internalUser.id,
        reviewed_at: new Date().toISOString(),
        review_notes: reviewNotes || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", correctionId);

    if (error) {
      console.error("[corrections] Review error:", error);
      return NextResponse.json({ error: "Failed to review correction" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  }

  // ── Admin: apply an approved correction to canonical plan ──────────────
  if (action === "apply") {
    if (internalUser.is_admin !== true) {
      return NextResponse.json({ error: "Admin only" }, { status: 403 });
    }

    const { correctionId } = body as { correctionId: string };
    if (!correctionId) {
      return NextResponse.json({ error: "correctionId required" }, { status: 400 });
    }

    // B9 B1.2 — admin-authority cross-user access (is_admin verified above; adminScoped
    // re-verifies). One verification, reused for the read here + the status update below.
    const admin = await adminScoped(supabase, internalUser.id);

    // Fetch the correction
    const { data: correction } = await admin
      .table("benefit_corrections")
      .select("*")
      .eq("id", correctionId)
      .single();

    if (!correction || correction.status !== "approved") {
      return NextResponse.json({ error: "Correction not found or not approved" }, { status: 400 });
    }

    // Apply to canonical_plan_services if canonical plan exists
    if (!correction.canonical_plan_id) {
      return NextResponse.json({ error: "This correction has no linked canonical plan — cannot auto-apply. Mark as approved and apply manually." }, { status: 400 });
    }

    if (correction.canonical_plan_id) {
      // 'other' is free-text → genuinely needs human judgment (no typed field to map to). Every
      // structured field — including annual_limit (mig 157 added its apply_promotion_event arm) —
      // routes through the canonical write authority below.
      if (correction.field === "other") {
        return NextResponse.json(
          { error: "Corrections with field type 'other' cannot be auto-applied. Review the notes and update the canonical plan manually." },
          { status: 400 },
        );
      }

      // Map the correction field → apply_promotion_event field name + a typed JSON value.
      const value = correction.proposed_value as string;
      let fieldName: string;
      let promotedValue: unknown;
      switch (correction.field) {
        case "copay": {
          const parsed = parseFloat(value.replace(/[$,]/g, ""));
          if (isNaN(parsed)) return NextResponse.json({ error: "Invalid copay value — must be a number" }, { status: 400 });
          fieldName = "in_copay"; promotedValue = parsed; break;  // F.0 Phase 2 (mig 169): aligned name
        }
        case "coinsurance": {
          const parsed = parseFloat(value.replace(/%/g, ""));
          if (isNaN(parsed)) return NextResponse.json({ error: "Invalid coinsurance value — must be a number" }, { status: 400 });
          // Normalize percent → fraction (apply_promotion_event also clamps to [0,1]).
          fieldName = "in_coinsurance"; promotedValue = parsed > 1 ? parsed / 100 : parsed; break;
        }
        case "covered":
          fieldName = "covered"; promotedValue = value.toLowerCase() === "true" || value.toLowerCase() === "yes"; break;
        case "prior_auth":
          fieldName = "prior_auth_required"; promotedValue = value.toLowerCase() === "true" || value.toLowerCase() === "yes"; break;
        case "deductible_applies":
          fieldName = "in_deductible_applies"; promotedValue = value.toLowerCase() === "true" || value.toLowerCase() === "yes"; break;
        case "annual_limit": {
          const parsed = parseInt(value.replace(/[,$]/g, ""), 10);
          if (isNaN(parsed)) return NextResponse.json({ error: "Invalid annual limit — must be a number" }, { status: 400 });
          fieldName = "annual_limit"; promotedValue = parsed; break;
        }
        default:
          return NextResponse.json({ error: `Unsupported correction field '${correction.field}'.` }, { status: 400 });
      }

      // Resolve the ONE cost-share cell to correct — never over-write all pos/component variants.
      // Priority: the cell the user flagged (captured at submit, mig 157) → the sole existing cell
      // → base (any, global) when none exist yet. A multi-cell service with no captured cell is
      // rejected rather than guessed (no silent corruption of the other variants).
      let targetPos: string | null = (correction.place_of_service as string | null) ?? null;
      let targetComponent: CoverageComponent | null = correction.component
        ? coerceComponent(correction.component)
        : null;
      if (!targetPos || !targetComponent) {
        const { data: cells } = await supabase
          .from("canonical_plan_services")
          .select("place_of_service, component")
          .eq("canonical_plan_id", correction.canonical_plan_id)
          .eq("service_slug", correction.service_slug);
        if (!cells || cells.length === 0) {
          targetPos = "any";
          targetComponent = "global";
        } else if (cells.length === 1) {
          targetPos = (cells[0].place_of_service as string) ?? "any";
          targetComponent = coerceComponent(cells[0].component);
        } else {
          return NextResponse.json(
            { error: `This service has ${cells.length} cost-sharing variants (e.g. facility vs professional). Re-submit the correction from the specific benefit row, or apply it manually — applying one value to all variants would corrupt the others.` },
            { status: 409 },
          );
        }
      }

      // Route through the canonical write authority: cell-targeted (4-col), typed column +
      // field_provenance synced atomically, audited as an admin_override (source='admin_attested').
      const sources = [{
        user_id_hash: `admin:${internalUser.id}`,
        excerpt: correction.notes || `Admin-applied benefit correction ${correctionId}`,
        document_ref: `benefit_correction:${correctionId}`,
        recorded_at: new Date().toISOString(),
      }];
      const { eventId, error: applyError } = await applyPromotionEvent(
        supabase,
        correction.canonical_plan_id,
        correction.service_slug,
        fieldName,
        promotedValue,
        sources,
        "admin-ui",
        internalUser.id,
        "admin_override",
        targetPos ?? "any",
        targetComponent ?? "global",
      );
      if (applyError || !eventId) {
        console.error("[corrections] Apply error:", applyError);
        return NextResponse.json({ error: "Failed to apply correction" }, { status: 500 });
      }
    }

    // Mark as applied (B9 B1.2 — same admin-authority accessor as the fetch above)
    await admin
      .table("benefit_corrections")
      .update({ status: "applied", updated_at: new Date().toISOString() })
      .eq("id", correctionId);

    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
