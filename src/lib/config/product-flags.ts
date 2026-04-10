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
