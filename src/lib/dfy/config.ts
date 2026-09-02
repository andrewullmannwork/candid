/**
 * config — the dfy_operator_v1 flag + its config, read in ONE place.
 *
 * Every cap and window is config-backed (Ship Gate G6):
 *   concurrent_cap                 per-OPERATOR live matters (signed + active)
 *   refusal_runway_business_days   R18 intake refusal threshold
 *   ip_allowlist / _enforced       D8 access hardening for the operator surface
 *   marketing_gate_verified_on     Gate 6 — the date the approved marketing
 *                                  sweep was verified complete; null = every
 *                                  applicant is refused (the homepage is the
 *                                  exhibit that defeats Gate 0).
 *
 *   fee_cents                      member-paid fee (0 = free pilot; 500 = $5 on counsel signature)
 *   designation_named_party        {erisa_plan, plan_internal_grievance}: individual | entity
 *   sla_days                       operator SLA — days without an act before the cron flags a matter
 *   access_review                  {at, by} — the last D8 weekly access review (written by the review route)
 *   entry_point_enabled            the member-initiated entry point (off until Gate 6 + counsel)
 *
 * Tune with:
 *   UPDATE feature_flag_rules SET config = config || '{"concurrent_cap": 8}'
 *   WHERE flag_key = 'dfy_operator_v1';
 * Bad values fall to the defaults on read (the overlay coerces; a future
 * editor validates strictly, the ID-Block §5 pattern).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerClient } from "@/lib/supabase/server";

export const DFY_FLAG_KEY = "dfy_operator_v1";

export interface DfyConfig {
  concurrentCap: number;
  refusalRunwayBusinessDays: number;
  ipAllowlist: string[];
  ipAllowlistEnforced: boolean;
  /** YYYY-MM-DD or null. */
  marketingGateVerifiedOn: string | null;
  /** The member-paid fee, in cents. 0 = the free pilot (S326 ruling: free pilot
   *  first; the $5 charge flips on counsel's opinion signature — set 500 then). */
  feeCents: number;
  /** The who-is-named variant seam (counsel Q2): which name appears on the
   *  designation per channel. Andrew (S330): the ENTITY — Airgetlam Labs LLC,
   *  the operator of Candid — so the member can sign the designation at once,
   *  before any operator holds the matter. "individual" remains available per
   *  channel (the DMHC 20-160 "person assisting" field is the MEMBER's own
   *  state-level form and is unaffected). */
  designationNamedParty: { erisa_plan: "individual" | "entity"; plan_internal_grievance: "individual" | "entity" };
  /** Operator SLA: an active matter with no operator act for this many days,
   *  or with runway under the refusal threshold, is flagged on the daily cron. */
  slaDays: number;
  /** D8 weekly access review — the last review, logged by an admin. */
  accessReview: { at: string | null; by: string | null };
  /** The member-initiated entry point (/appeal-service + the hero CTA). Off
   *  until Gate 6 is attested and counsel signs — the pilot is invitation-only. */
  entryPointEnabled: boolean;
  /** Slack channel for operator notifications — new requests, completed paper,
   *  the SLA sweep. Null = the backend-ops default channel. */
  opsChannelId: string | null;
}

export const DFY_CONFIG_DEFAULTS: DfyConfig = Object.freeze<DfyConfig>({
  concurrentCap: 5,
  refusalRunwayBusinessDays: 10,
  ipAllowlist: [],
  ipAllowlistEnforced: false,
  marketingGateVerifiedOn: null,
  feeCents: 0,
  designationNamedParty: { erisa_plan: "entity", plan_internal_grievance: "entity" },
  slaDays: 3,
  accessReview: { at: null, by: null },
  entryPointEnabled: false,
  opsChannelId: null,
});

function posInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : fallback;
}
function nonNegInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : fallback;
}
function namedParty(v: unknown, fallback: "individual" | "entity"): "individual" | "entity" {
  return v === "entity" || v === "individual" ? v : fallback;
}

export function parseDfyConfig(raw: unknown): DfyConfig {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(c.ip_allowlist)
    ? c.ip_allowlist.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim())
    : DFY_CONFIG_DEFAULTS.ipAllowlist;
  const verified =
    typeof c.marketing_gate_verified_on === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c.marketing_gate_verified_on)
      ? c.marketing_gate_verified_on
      : null;
  return {
    concurrentCap: posInt(c.concurrent_cap, DFY_CONFIG_DEFAULTS.concurrentCap),
    refusalRunwayBusinessDays: posInt(
      c.refusal_runway_business_days,
      DFY_CONFIG_DEFAULTS.refusalRunwayBusinessDays,
    ),
    ipAllowlist: list,
    ipAllowlistEnforced: c.ip_allowlist_enforced === true,
    marketingGateVerifiedOn: verified,
    feeCents: nonNegInt(c.fee_cents, DFY_CONFIG_DEFAULTS.feeCents),
    designationNamedParty: {
      erisa_plan: namedParty((c.designation_named_party as Record<string, unknown> | undefined)?.erisa_plan, "entity"),
      plan_internal_grievance: namedParty((c.designation_named_party as Record<string, unknown> | undefined)?.plan_internal_grievance, "entity"),
    },
    slaDays: posInt(c.sla_days, DFY_CONFIG_DEFAULTS.slaDays),
    accessReview: {
      at: typeof (c.access_review as Record<string, unknown> | undefined)?.at === "string" ? ((c.access_review as Record<string, unknown>).at as string) : null,
      by: typeof (c.access_review as Record<string, unknown> | undefined)?.by === "string" ? ((c.access_review as Record<string, unknown>).by as string) : null,
    },
    entryPointEnabled: c.entry_point_enabled === true,
    opsChannelId: typeof c.ops_channel_id === "string" && /^[A-Z0-9]{8,}$/.test(c.ops_channel_id) ? c.ops_channel_id : null,
  };
}

export interface DfyState {
  enabled: boolean;
  config: DfyConfig;
}

/** The flag row, read fresh (operator surface volume is low; truth beats a cache here). */
export async function readDfyState(supabase?: SupabaseClient): Promise<DfyState> {
  const sb = supabase ?? createServerClient();
  const { data } = await sb
    .from("feature_flag_rules")
    .select("enabled, config")
    .eq("flag_key", DFY_FLAG_KEY)
    .maybeSingle();
  return {
    enabled: (data as { enabled?: boolean } | null)?.enabled === true,
    config: parseDfyConfig((data as { config?: unknown } | null)?.config),
  };
}

/** Pure: is this address admitted by the allowlist policy? Empty list or not enforced = admitted. */
export function ipAdmitted(ip: string | null, config: Pick<DfyConfig, "ipAllowlist" | "ipAllowlistEnforced">): boolean {
  if (!config.ipAllowlistEnforced || config.ipAllowlist.length === 0) return true;
  return ip !== null && config.ipAllowlist.includes(ip);
}

/** Days since the last access review; null when never reviewed. */
export function accessReviewAgeDays(config: Pick<DfyConfig, "accessReview">, now: Date = new Date()): number | null {
  if (!config.accessReview.at) return null;
  const at = new Date(config.accessReview.at).getTime();
  if (Number.isNaN(at)) return null;
  return Math.floor((now.getTime() - at) / 86_400_000);
}

/** The D8 review is WEEKLY: stale when older than 7 days or never done. */
export function accessReviewStale(config: Pick<DfyConfig, "accessReview">, now: Date = new Date()): boolean {
  const age = accessReviewAgeDays(config, now);
  return age === null || age > 7;
}

/** Write one config key back (read-merge-write on the flag row's JSONB). */
export async function writeDfyConfigKey(
  supabase: SupabaseClient,
  key: string,
  value: unknown,
): Promise<void> {
  const { data } = await supabase.from("feature_flag_rules").select("config").eq("flag_key", DFY_FLAG_KEY).maybeSingle();
  const current = ((data as { config?: Record<string, unknown> } | null)?.config ?? {}) as Record<string, unknown>;
  const { error } = await supabase
    .from("feature_flag_rules")
    .update({ config: { ...current, [key]: value }, updated_at: new Date().toISOString() })
    .eq("flag_key", DFY_FLAG_KEY);
  if (error) throw error;
}
