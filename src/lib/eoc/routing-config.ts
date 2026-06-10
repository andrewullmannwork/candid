/**
 * EOC content-routing config (Service Thesaurus P2 — T2). Mirrors the `service_resolver_v1`
 * config pattern (`loadResolverConfig`): a pure validator with per-field 0..1 clamp + default,
 * and an async loader that reads `feature_flag_rules.config` JSONB for `eoc_prose_prior_auth_v1`.
 * Kept separate from the PURE `route-criterion.ts` so that module stays DB-free.
 *
 * Tunable at `/admin/flags` (the same inline config editor ID-Block uses). OFF/empty config →
 * the default floor, so the router degrades safely with no flag seeded.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface EocRoutingConfig {
  /** type_confidence floor a service-specific prose `prior_auth` must clear to reach the user-visible
   *  `prior_auth_required` column. Below it → captured in `eoc_prior_auth_facts[]`, not surfaced. */
  prosePaTypeConfidenceFloor: number;
}

export const DEFAULT_EOC_ROUTING_CONFIG: EocRoutingConfig = {
  prosePaTypeConfidenceFloor: 0.7,
};

/** Parse + validate the config from a `feature_flag_rules.config` JSONB; per-field default on invalid. */
export function parseEocRoutingConfig(raw: unknown): EocRoutingConfig {
  const out = { ...DEFAULT_EOC_ROUTING_CONFIG };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" && v >= 0 && v <= 1 ? v : null);
  out.prosePaTypeConfidenceFloor =
    num(r.prose_pa_type_confidence_floor) ?? out.prosePaTypeConfidenceFloor;
  return out;
}

export async function loadEocRoutingConfig(supabase: SupabaseClient): Promise<EocRoutingConfig> {
  try {
    const { data } = await supabase
      .from("feature_flag_rules")
      .select("config")
      .eq("flag_key", "eoc_prose_prior_auth_v1")
      .maybeSingle();
    return parseEocRoutingConfig(data?.config);
  } catch {
    return { ...DEFAULT_EOC_ROUTING_CONFIG };
  }
}
