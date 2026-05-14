/**
 * S74.6 §C.1 D3 — Pre-flight slug resolution for a parsed bill.
 *
 * Before §C.1, service-mapping ran INSIDE persistAuditResults — after
 * runAudit. That blocked the audit pipeline from using slug as a cohort-key
 * dimension and prevented D4 description-match from knowing whether a line
 * already had a slug. This module hoists slug resolution to run BEFORE audit.
 *
 * Three resolution sources, applied in order:
 *   1. `flywheel_identity` — billing_code_identity row with corroborated slug
 *      (Pattern 1 #3 cross-user signal). Returns identityId for persist.
 *   2. `service_mapper` — legacy cached-mapping + Haiku batch service-mapper
 *      (covers cached billing_code_mappings hits + Haiku fallback together).
 *
 * Flywheel result wins on conflict (D4 §3 LOCK preserved); legacy is fallback
 * for lines without a flywheel-resolved slug.
 *
 * Output is written back onto bill.lineItems[i] via `serviceSlug` +
 * `serviceSlugSource` + `billingCodeIdentityId` (mutation in place) so
 * downstream consumers (runAudit cohort lookup, D4 description-match filter,
 * persist line-item INSERT) all see the same resolution.
 *
 * Per-line `recordParserObservation` ALSO fires inside this helper when the
 * flywheel path resolves an identity_id — the observation is independent of
 * future line_item_id and was already passing null in the legacy persist path.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedBill } from "@/lib/billing/types";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import {
  mapLineItemsToServices,
  inferBillingCodeType,
} from "./service-mapper";
import { categorizeLineItem } from "@/lib/parser/code-identity";
import { recordParserObservation } from "@/lib/parser/code-identity-promotion";
import { reconcileHaikuCodeType } from "@/lib/billing/code-type-inference";

export interface ResolvedLineSlug {
  lineNumber: number;
  slug: string | null;
  source: "cached_mapping" | "service_mapper" | "flywheel_identity" | null;
  identityId: string | null;
  confidence: number;
  needsReview: boolean;
}

export type ResolvedSlugMap = Map<number, ResolvedLineSlug>;

/**
 * First-audit path (process-chunk + admin re-classify). Runs flywheel + legacy
 * service-mapper, mutates bill.lineItems[i].serviceSlug/serviceSlugSource/billingCodeIdentityId,
 * and returns the per-line map for persist to reuse without re-running.
 *
 * Non-blocking: each branch logs and swallows errors so a flywheel hiccup
 * doesn't drop the whole audit.
 */
export async function resolveLineItemSlugs(
  _supabase: SupabaseClient,
  userId: string | null,
  parsedBill: ParsedBill,
): Promise<ResolvedSlugMap> {
  const out: ResolvedSlugMap = new Map();
  if (parsedBill.lineItems.length === 0) return out;

  const flywheelEnabled = await isFeatureEnabled(
    "s74_5_categorization_flywheel_v1",
  );
  const serviceMappingEnabled = await isFeatureEnabled(
    "billing_code_service_mapping",
  );

  // Phase 1 — flywheel categorize per line. Returns identityId + slug (when
  // identity row resolved) or proposes a new one. Pattern 1 #15 verification
  // gates `recordParserObservation` inside the helper; unverified users no-op.
  if (flywheelEnabled && userId) {
    for (const item of parsedBill.lineItems) {
      const code = item.procedureCode || "";
      if (!code) continue;
      const codeType =
        reconcileHaikuCodeType(code, item.procedureCodeType) ?? undefined;
      const description = item.description || item.category || "";
      try {
        const r = await categorizeLineItem({
          code,
          codeType,
          description,
          userId,
        });
        if (r.identityId && userId) {
          try {
            await recordParserObservation({
              identityId: r.identityId,
              userId,
              rawDescription: description,
              lineItemId: null,
            });
          } catch (obsErr) {
            console.warn(
              "[preflight-slug-resolver] parser observation failed for line",
              item.lineNumber,
              obsErr,
            );
          }
        }
        if (r.identityId || r.serviceSlug) {
          out.set(item.lineNumber, {
            lineNumber: item.lineNumber,
            slug: r.serviceSlug,
            source: r.serviceSlug ? "flywheel_identity" : null,
            identityId: r.identityId,
            confidence: r.confidence,
            needsReview: r.needsReview,
          });
        }
      } catch (err) {
        console.warn(
          "[preflight-slug-resolver] flywheel categorize failed for line",
          item.lineNumber,
          err,
        );
      }
    }
  }

  // Phase 2 — legacy cached-mapping + Haiku service-mapper for lines without
  // a flywheel-resolved slug. mapLineItemsToServices internally checks
  // billing_code_mappings cache first then falls back to Haiku, so the result
  // collapses both sources under 'service_mapper'. Phase 2 follow-up could
  // distinguish if needed.
  if (serviceMappingEnabled) {
    const unresolved = parsedBill.lineItems.filter(
      (li) => !out.get(li.lineNumber)?.slug,
    );
    if (unresolved.length > 0) {
      const inputItems = unresolved.map((item) => ({
        lineNumber: item.lineNumber,
        description: item.description || item.category || "",
        billingCode: item.procedureCode || undefined,
        billingCodeType: item.procedureCode
          ? inferBillingCodeType(item.procedureCode)
          : undefined,
        category: item.category || undefined,
      }));

      try {
        const mappings = await mapLineItemsToServices(inputItems);
        for (const m of mappings) {
          if (m.confidence < 0.3) continue;
          const prior = out.get(m.lineNumber);
          out.set(m.lineNumber, {
            lineNumber: m.lineNumber,
            slug: m.serviceSlug,
            source: "service_mapper",
            identityId: prior?.identityId ?? null,
            confidence: m.confidence,
            needsReview: prior?.needsReview ?? false,
          });
        }
      } catch (err) {
        console.warn(
          "[preflight-slug-resolver] service-mapper failed (non-blocking)",
          err,
        );
      }
    }
  }

  // Mutate bill.lineItems in place. Downstream readers (runAudit cohort
  // lookup, D4 description-match filter, persist INSERT) all consume from
  // the bill shape directly.
  for (const item of parsedBill.lineItems) {
    const resolved = out.get(item.lineNumber);
    if (resolved) {
      item.serviceSlug = resolved.slug;
      item.serviceSlugSource = resolved.source;
      item.billingCodeIdentityId = resolved.identityId;
    }
  }

  console.log(
    `[preflight-slug-resolver] resolved ${out.size}/${parsedBill.lineItems.length} lines`,
  );
  return out;
}

/**
 * Reaudit / dispute-rerun helper: line items already have persisted
 * service_slug + billing_code_identity_id in the DB. Reconstruct the bill,
 * then call this to thread DB values onto the in-memory BillLineItem shape —
 * no re-resolution.
 */
export function applyPersistedSlugs(
  parsedBill: ParsedBill,
  rows: Array<{
    line_number: number;
    service_slug: string | null;
    billing_code_identity_id?: string | null;
  }>,
): void {
  const map = new Map<
    number,
    { service_slug: string | null; billing_code_identity_id?: string | null }
  >();
  for (const r of rows) {
    map.set(r.line_number, {
      service_slug: r.service_slug,
      billing_code_identity_id: r.billing_code_identity_id,
    });
  }
  for (const item of parsedBill.lineItems) {
    const r = map.get(item.lineNumber);
    if (r) {
      item.serviceSlug = r.service_slug;
      item.serviceSlugSource = r.service_slug ? "persisted" : null;
      item.billingCodeIdentityId = r.billing_code_identity_id ?? null;
    }
  }
}
