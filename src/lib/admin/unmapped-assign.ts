/**
 * assignUnmappedGroup — the write sequence behind POST /api/admin/line-items/unmapped
 * (plans/unmapped_line_items_admin_fix.md). Server-only.
 *
 * Coded groups complete the flywheel path the parser skipped: find-or-create the
 * billing_code_identity (proposeNewSignature) → promote_with_slug RPC
 * (admin_verified — the same atomic path as /api/admin/code-identity/promote) →
 * stamp the null-slug line items → backfillCorroboratedMapping for linked peers →
 * cacheLearnedMapping so the resolver stage learns too. Code-less groups update
 * rows directly + cache by description signature (the flywheel is code-keyed).
 *
 * Factored out of the route so scripts/admin-unmapped-dev-proof.ts can exercise
 * the identical sequence against the dev clone (empirical seam proof pre-PR).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeDescriptionSignature, proposeNewSignature } from "@/lib/parser/code-identity";
import { toIdentityCodeType } from "@/lib/admin/unmapped-line-items";
import { backfillCorroboratedMapping } from "@/lib/parser/code-identity-promotion";
import { cacheLearnedMapping } from "@/lib/claims/service-resolver";

export interface AssignUnmappedInput {
  billingCode: string | null;
  /** RAW type as stored on claim_line_items ('HCPCS', 'NDC', …) — used verbatim
   *  for the row UPDATE match + the resolver cache key (future line lookups hit);
   *  the flywheel identity write derives its own vocabulary via toIdentityCodeType. */
  codeType: string | null;
  description: string;
  serviceSlug: string;
  /** users.id of the acting admin — recorded by the promotion RPC. */
  actorUserId: string;
}

export type AssignUnmappedResult =
  | { ok: true; updatedCount: number; identityId: string | null; backfillUpdated: number }
  | { ok: false; status: number; error: string };

/**
 * Cross-user read of null-slug line items for the admin surface. Lives HERE
 * (not in the route) per the B9 B1 discipline: routes never hold a raw
 * user-table `.from()`; deliberate cross-user access sits in a named lib module
 * with its authority documented (same placement as backfillCorroboratedMapping).
 * Caller MUST be behind requireAdmin — this module never sees end-user ids.
 */
export async function fetchUnmappedLineItemRows(
  supabase: SupabaseClient,
  limit: number,
): Promise<{ rows: { id: string; billing_code: string | null; billing_code_type: string | null; description: string | null }[] | null; error: string | null }> {
  const { data, error } = await supabase
    .from("claim_line_items")
    .select("id, billing_code, billing_code_type, description")
    .is("service_slug", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  return { rows: data ?? null, error: error?.message ?? null };
}

export async function assignUnmappedGroup(
  supabase: SupabaseClient,
  input: AssignUnmappedInput,
): Promise<AssignUnmappedResult> {
  const { billingCode, codeType, description, serviceSlug, actorUserId } = input;
  const coded = Boolean(billingCode && codeType);

  // Validate the slug against the live catalog (same gate as correct-category + promote).
  const { data: slugRow } = await supabase
    .from("service_catalog")
    .select("slug")
    .eq("slug", serviceSlug)
    .maybeSingle();
  if (!slugRow) {
    return { ok: false, status: 400, error: `Unknown service slug: ${serviceSlug}` };
  }

  let identityId: string | null = null;
  let backfillUpdated = 0;

  const identityCodeType = toIdentityCodeType(codeType, billingCode);
  if (billingCode && codeType && !identityCodeType) {
    return { ok: false, status: 400, error: `Unknown billing code type: ${codeType}` };
  }

  if (billingCode && identityCodeType) {
    const signature = normalizeDescriptionSignature(description, billingCode);
    const identity = await proposeNewSignature({
      code: billingCode,
      codeType: identityCodeType,
      signature,
      rawDescription: description,
      proposedSlug: null, // slug lands atomically inside promote_with_slug below
      proposedByUserId: null,
    });
    if (!identity) {
      return { ok: false, status: 500, error: "Failed to create identity row" };
    }
    identityId = identity.identityId;

    const { error: rpcErr } = await supabase.rpc("promote_with_slug", {
      p_identity_id: identityId,
      p_new_state: "admin_verified",
      p_set_slug: serviceSlug,
      p_fire_source: "admin-ui",
      p_actor_user_id: actorUserId,
    });
    if (rpcErr) {
      return { ok: false, status: 500, error: rpcErr.message };
    }

    // Propagate across peers already linked to this identity (respects user locks).
    try {
      const backfill = await backfillCorroboratedMapping(identityId, serviceSlug);
      backfillUpdated = backfill.updatedRowCount;
    } catch (err) {
      console.warn("[unmapped-assign] peer backfill failed (non-fatal)", err);
    }
  }

  // Stamp the null-slug rows themselves. backfillCorroboratedMapping matches on
  // billing_code_identity_id, which is NULL for rows the parser never engaged —
  // this direct update is what actually clears the group (and links coded rows
  // to the identity so future flows treat them as flywheel-resolved).
  let update = supabase
    .from("claim_line_items")
    .update(
      identityId
        ? { service_slug: serviceSlug, billing_code_identity_id: identityId }
        : { service_slug: serviceSlug },
    )
    .is("service_slug", null)
    .is("user_correction_locked_at", null)
    .eq("description", description);
  update = coded
    ? update.eq("billing_code", billingCode!).eq("billing_code_type", codeType!)
    : update.is("billing_code", null);
  const { data: updatedRows, error: updateErr } = await update.select("id");
  if (updateErr) {
    return { ok: false, status: 500, error: updateErr.message };
  }

  // Teach the resolver stage too (mirrors correct-category: coded rows cache by
  // code, code-less rows cache by description signature).
  try {
    await cacheLearnedMapping(supabase, {
      code: coded ? billingCode : null,
      codeType: coded ? codeType : null,
      signature: coded ? null : normalizeDescriptionSignature(description, ""),
      slug: serviceSlug,
      confidence: 0.95,
      description,
      source: "admin_assign",
    });
  } catch (err) {
    console.warn("[unmapped-assign] cacheLearnedMapping failed (non-fatal)", err);
  }

  return { ok: true, updatedCount: updatedRows?.length ?? 0, identityId, backfillUpdated };
}
