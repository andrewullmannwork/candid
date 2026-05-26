"use client";

/**
 * Brand-moment minimum-hold for CubeLoaderBuilding usages.
 *
 * B-LOAD.1 follow-up (S131) — Andrew direction: "For the box loader, always
 * let it do one check mark (even if it loads faster than that). Good for
 * branding and still really quick."
 *
 * Wraps an existing `loading: boolean` such that the returned value stays
 * `true` for at least `minMs` after mount. Used at page-level CubeLoaderBuilding
 * sites so a fast-resolving data fetch can't unmount the loader before the
 * 0.9s cdCheckDraw cycle completes one full check stamp.
 *
 * Does NOT apply to Next.js `loading.tsx` files — Suspense controls their
 * mount/unmount timing and we can't enforce min-hold there. The companion
 * 2.2s → 0.9s `cdCheckDraw` speedup makes the check visible at sub-second
 * Suspense flashes as the secondary mitigation.
 *
 * Default minMs = 900 (matches cdCheckDraw cycle).
 */

import { useEffect, useState } from "react";

export function useMinHoldLoading(loading: boolean, minMs = 900): boolean {
  const [holdMet, setHoldMet] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setHoldMet(true), minMs);
    return () => clearTimeout(t);
  }, [minMs]);
  return loading || !holdMet;
}
