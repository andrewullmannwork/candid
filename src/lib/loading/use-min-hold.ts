"use client";

/**
 * Brand-moment minimum-hold for CubeLoaderBuilding usages.
 *
 * Wraps an existing `loading: boolean` such that the returned value stays
 * `true` for at least `minMs` after mount. Used at page-level CubeLoaderBuilding
 * sites so a fast-resolving data fetch can't unmount the loader before the
 * cdCheckDraw cycle completes one full check stamp.
 *
 * Does NOT apply to Next.js `loading.tsx` files — Suspense controls their
 * mount/unmount timing and we can't enforce min-hold there.
 *
 * Default minMs = 2000 (matches cdCheckDraw 2.0s cycle per S132 iter-2 —
 * 1.6s still felt fast on /support; 2.0s reads deliberate).
 */

import { useEffect, useState } from "react";

export function useMinHoldLoading(loading: boolean, minMs = 2000): boolean {
  const [holdMet, setHoldMet] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setHoldMet(true), minMs);
    return () => clearTimeout(t);
  }, [minMs]);
  return loading || !holdMet;
}
