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
      .then(async (r) => {
        // S302 — a key missing from EXPOSED_FLAGS answers 404 → { enabled:false },
        // indistinguishable from a flag that is genuinely off. That cost a full
        // E2E round: `bill_totals_source_v1` was ON in the database, the row was
        // built and tested, and it rendered nowhere because the allowlist entry
        // was missing. Graceful degradation is right in PRODUCTION and wrong in
        // development, where a silent 404 is always a wiring bug. Dev-only, so
        // production behaviour is unchanged.
        if (r.status === 404 && process.env.NODE_ENV !== "production") {
          console.error(
            `[useFeatureFlag] "${flagKey}" is not in EXPOSED_FLAGS ` +
              "(src/app/api/feature-flags/[flagKey]/route.ts). It will read as OFF " +
              "no matter what the database says.",
          );
        }
        return r.json();
      })
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
