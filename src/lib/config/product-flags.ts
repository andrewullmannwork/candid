import { createServerClient } from "@/lib/supabase/server";

/**
 * Check if a product feature flag is enabled for a specific user.
 * Product flags are separate from system flags (feature_flags table).
 * They support targeting: global, specific users (by email), or percentage rollout.
 */
export async function isFeatureEnabled(
  flagKey: string,
  userEmail?: string
): Promise<boolean> {
  const supabase = createServerClient();

  const { data: flag } = await supabase
    .from("feature_flag_rules")
    .select("enabled, target_type, target_users, target_percentage")
    .eq("flag_key", flagKey)
    .single();

  if (!flag || !flag.enabled) return false;

  switch (flag.target_type) {
    case "global":
      return true;

    case "users":
      if (!userEmail) return false;
      return (flag.target_users || []).includes(userEmail);

    case "percentage": {
      if (!userEmail) return false;
      // Deterministic hash so same user always gets same result for same flag
      const hash = simpleHash(userEmail + ":" + flagKey);
      return hash % 100 < (flag.target_percentage ?? 100);
    }

    default:
      return false;
  }
}

/**
 * Read a typed config value from `feature_flag_rules.config` JSONB (mig 067).
 *
 * Used for non-boolean flag configuration (e.g.,
 * pattern1_corroboration_threshold has config = {value: 3} representing the
 * distinct-user count threshold for canonical-source corroboration). Returns
 * `fallback` when the flag row is missing, the config key is absent, or the
 * value type doesn't match.
 *
 * Type parameter T narrows the return type. Type checking is shallow (typeof);
 * complex shapes should add a runtime parser at the call site.
 */
export async function readFeatureFlagConfig<T extends string | number | boolean>(
  flagKey: string,
  configKey: string,
  fallback: T,
): Promise<T> {
  const supabase = createServerClient();
  const { data: flag } = await supabase
    .from("feature_flag_rules")
    .select("enabled, config")
    .eq("flag_key", flagKey)
    .single();

  if (!flag || !flag.enabled) return fallback;
  const config = flag.config as Record<string, unknown> | null;
  if (!config || !(configKey in config)) return fallback;
  const value = config[configKey];
  if (typeof value !== typeof fallback) return fallback;
  return value as T;
}

/**
 * Simple deterministic hash for percentage rollout.
 * Not cryptographic — just needs to be consistent and well-distributed.
 */
function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}
