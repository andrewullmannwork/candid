"use client";

import { useEffect, useState } from "react";

/**
 * useFeatureFlag — client-side read of a product flag via the server endpoint.
 *
 * Client components can't call isFeatureEnabled (it needs the service-role
 * Supabase client) and a browser-Supabase read of feature_flag_rules returns
 * [] under Firebase auth (RLS keys off auth.uid()). So we go through
 * GET /api/feature-flags/[flagKey], which must whitelist the key in
 * EXPOSED_FLAGS. See [[feedback_candid_client_flag_reads]].
 *
 * Defaults to { enabled: false, loading: true } → callers show today's
 * (flag-OFF) behavior until the read resolves, so a missing/unreadable flag
 * degrades gracefully to the status quo.
 */
export function useFeatureFlag(flagKey: string): { enabled: boolean; loading: boolean } {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // `loading` starts true (useState) and flips false when the fetch settles.
    // No synchronous setState here — flagKey is a constant per caller, and
    // setState-in-effect-body triggers cascading renders (react-hooks lint).
    let cancelled = false;
    fetch(`/api/feature-flags/${flagKey}`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setEnabled(!!d?.enabled);
      })
      .catch(() => {
        if (!cancelled) setEnabled(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [flagKey]);

  return { enabled, loading };
}
