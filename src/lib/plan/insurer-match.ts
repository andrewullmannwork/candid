import type { SupabaseClient } from "@supabase/supabase-js";
import { inferCarrierFromPlanName } from "@/lib/disputes/plan-context";

export type InsurerMatchVia = "insurer_name" | "plan_name_inference";

/** Lowercase + strip non-alphanumerics — the S288 card-preservation normalizer
 *  (formerly private to set-active-canonical.ts). */
export const normalizeInsurerName = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Family test — do two insurer NAMES describe one carrier family? (S292)
 *
 * Pure + synchronous: normalized-name containment either way, exactly the
 * `substringMatch`/`familyMatch` logic set-active-canonical.ts shipped at S288.
 * Extracted because the SAME problem bit the plan-identity resolver: the
 * insurer_catalog carries one row per LEGAL ENTITY (dozens of Blue-Cross-family
 * rows), so resolving a bare brand name ("Blue Cross") to a catalog id is
 * order-dependent luck — `matchInsurerCatalog` returns the first substring hit.
 * Two DIFFERENT resolved ids therefore do not prove two different carriers when
 * the names themselves agree ("Blue Cross" ⊂ "Blue Cross Blue Shield of
 * Wyoming").
 *
 * Compares NAMES, never resolved ids — that asymmetry is the point: ids are
 * strong evidence of sameness (alias-aware) but weak evidence of difference
 * within a family. Either side blank → false (no evidence is not agreement).
 */
export function insurerNamesSameFamily(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const an = normalizeInsurerName(a ?? "");
  const bn = normalizeInsurerName(b ?? "");
  return !!an && !!bn && (an.includes(bn) || bn.includes(an));
}

export interface CardPreservationDecision {
  /** Prior active plan was nothing / a card-or-manual stub — the user is
   *  ASSEMBLING one plan (card + document), not switching plans. */
  assembly: boolean;
  /** Keep profile member_id / group_number. False ONLY on a confident
   *  cross-insurer switch. */
  preserveCard: boolean;
}

/**
 * THE shared card-preservation decision (S288 e3e finding, extracted S292 so
 * activate_plan stops keeping its own contradictory copy).
 *
 * "A confirmed switch clears the other half" was designed for CHANGING an
 * established pair — not for signup ASSEMBLY, where the card was typed seconds
 * before the plan arrived and clearing it reads as data loss. Preserve the
 * card IDs when:
 *   - ASSEMBLY: the prior active row is just the card's manual/card stub (or
 *     nothing) — the user is building the pair, not switching plans; or
 *   - the prior insurer family-matches the new plan's insurer (same-insurer
 *     plan change — the card isn't stale).
 * Clear them only on a CONFIDENT cross-insurer switch — both sides resolved in
 * the insurer catalog AND different ids AND no family-name agreement. Any
 * uncertainty (unresolvable prior string, missing new-side identity, resolver
 * failure) PRESERVES: a possibly-stale card is visible and recoverable; a
 * destroyed member ID is data loss.
 *
 * `newInsurerCatalogId`: pass it when the caller already holds the new side's
 * exact catalog id (set-active-canonical has `canonical_plans.insurer_id`);
 * left null, it is resolved from `newInsurerName` — same alias-aware resolver,
 * same uncertainty-preserves fallback.
 */
export async function decideCardPreservation(
  supabase: SupabaseClient,
  params: {
    /** `source` of the prior ACTIVE plan row; null when there was none. */
    priorActiveSource: string | null;
    priorInsurerName: string | null;
    newInsurerName: string | null;
    newInsurerCatalogId?: string | null;
  },
): Promise<CardPreservationDecision> {
  const assembly =
    params.priorActiveSource === null ||
    params.priorActiveSource === "manual" ||
    params.priorActiveSource === "insurance_card";
  // Insurer comparison (Andrew's false-negative contingency): substring alone
  // false-negatives on abbreviations ("UHC" vs "UnitedHealthcare Insurance
  // Company") and would wrongly clear a same-insurer card — hence the catalog
  // resolve below when the names alone don't agree.
  const substringMatch = insurerNamesSameFamily(params.priorInsurerName, params.newInsurerName);
  let confidentMismatch = false;
  if (!assembly && !substringMatch && params.priorInsurerName) {
    try {
      const priorResolved = await matchInsurerCatalog(supabase, params.priorInsurerName);
      let newId = params.newInsurerCatalogId ?? null;
      if (newId == null && params.newInsurerName) {
        newId = (await matchInsurerCatalog(supabase, params.newInsurerName))?.id ?? null;
      }
      if (priorResolved != null && newId != null) {
        // Differing ids are a CONFIDENT mismatch only when the resolved row's
        // NAME and the new insurer name don't family-match either (the catalog
        // carries one row per legal entity — an alias resolves to the parent
        // while the new side may point at a sibling entity).
        const familyMatch = insurerNamesSameFamily(priorResolved.name, params.newInsurerName);
        confidentMismatch = priorResolved.id !== newId && !familyMatch;
      }
    } catch {
      confidentMismatch = false; // resolver failure → uncertainty → preserve
    }
  }
  return { assembly, preserveCard: assembly || !confidentMismatch };
}

export interface InsurerMatchResult {
  id: string;
  name: string;
  via: InsurerMatchVia;
}

/**
 * Fuzzy-match a raw insurer name against the insurer_catalog.
 * Returns the matched catalog entry or null.
 */
export async function matchInsurerCatalog(
  supabase: SupabaseClient,
  rawName: string
): Promise<{ id: string; name: string } | null> {
  if (!rawName || rawName.trim().length === 0) return null;

  const normalized = rawName.trim().toLowerCase();

  // Fetch all catalog entries (small table, ~70 rows)
  const { data: catalog } = await supabase
    .from("insurer_catalog")
    .select("id, name, aliases");

  if (!catalog || catalog.length === 0) return null;

  for (const entry of catalog) {
    const catalogName = (entry.name || "").toLowerCase();

    // Exact match
    if (catalogName === normalized) {
      return { id: entry.id, name: entry.name };
    }

    // Check aliases
    const aliases: string[] = entry.aliases || [];
    for (const alias of aliases) {
      if (alias.toLowerCase() === normalized) {
        return { id: entry.id, name: entry.name };
      }
    }

    // Substring containment (both directions)
    if (catalogName.includes(normalized) || normalized.includes(catalogName)) {
      return { id: entry.id, name: entry.name };
    }

    // Check alias substrings
    for (const alias of aliases) {
      const aliasLower = alias.toLowerCase();
      if (aliasLower.includes(normalized) || normalized.includes(aliasLower)) {
        return { id: entry.id, name: entry.name };
      }
    }
  }

  return null;
}

/**
 * Resolve the carrier insurer for a plan, with PEO-aware fallback.
 *
 * Some plans capture the group sponsor as `insurer_name` (e.g., a PEO like
 * "Sequoia One PEO, LLC") instead of the actual carrier (e.g., Cigna).
 * `matchInsurerCatalog` won't find those because PEOs aren't in the carrier
 * catalog. This wrapper falls through to plan-name carrier inference (which
 * understands "Open Access Plus" → Cigna, "Choice Plus" → UnitedHealthcare,
 * etc.) so canonical-plan linking still succeeds for PEO-administered plans.
 *
 * Returns the matched catalog entry plus a `via` discriminator the caller
 * can log / surface for confidence-tracking. Null if neither path matched.
 */
export async function matchInsurerWithPlanFallback(
  supabase: SupabaseClient,
  params: { insurerName: string | null | undefined; planName: string | null | undefined },
): Promise<InsurerMatchResult | null> {
  const direct = await matchInsurerCatalog(supabase, params.insurerName ?? "");
  if (direct) return { ...direct, via: "insurer_name" };

  const inferred = params.planName ? inferCarrierFromPlanName(params.planName) : null;
  if (!inferred) return null;

  const fromPlan = await matchInsurerCatalog(supabase, inferred);
  if (!fromPlan) return null;

  return { ...fromPlan, via: "plan_name_inference" };
}
