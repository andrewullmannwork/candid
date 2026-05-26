"use client";

/**
 * Persistent dispute-draft loader overlay (S132 iter-2).
 *
 * Andrew #3: "For dispute letter creation. The load screen still shifts
 * halfway through. Can we not make it the same load screen and do any
 * shifting in the background?"
 *
 * Root cause of the shift: today the BulkDisputeButton overlay lived INSIDE
 * ClaimDetail. During /claim → /disputes navigation, ClaimDetail unmounts,
 * the overlay unmounts, /disputes/loading.tsx mounts fresh, and then
 * /disputes/page.tsx's in-page loader mounts fresh — three separate React
 * mounts of the same component with reset animation state. The user sees
 * the loader visually "jump back" and restart.
 *
 * Fix: hoist the overlay to (app)/layout.tsx so it lives ABOVE the route
 * segment. One React mount, animation state preserved across navigation,
 * unmounts only when /disputes/page.tsx signals the letter is ready.
 *
 * S132 iter-8: unified on CubeLoaderBuilding (audit loader retired).
 *
 * Contract:
 *   - BulkDisputeButton.handleClick → start() before fetch
 *   - BulkDisputeButton catch → stop() on error
 *   - disputes/page.tsx → stop() when disputeFetching transitions to false
 *     (letter ready OR fetch errored)
 *   - disputes/page.tsx cleanup useEffect → stop() on unmount (safety net so
 *     overlay can't get stuck if user nav-aways mid-flow)
 */

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { CubeLoaderBuilding } from "@/components/loaders/CubeLoaderBuilding";

type DisputeDraftOverlayContextValue = {
  active: boolean;
  start: () => void;
  stop: () => void;
};

const DisputeDraftOverlayContext =
  createContext<DisputeDraftOverlayContextValue | null>(null);

export function DisputeDraftOverlayProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(false);
  const start = useCallback(() => setActive(true), []);
  const stop = useCallback(() => setActive(false), []);

  return (
    <DisputeDraftOverlayContext.Provider value={{ active, start, stop }}>
      {children}
      {active && (
        <div className="fixed inset-0 z-50 bg-white">
          {/* S132 iter-8 — unified cube loader; audit loader retired.
              Per Andrew direction (a): accept silence; cube has no title slot. */}
          <CubeLoaderBuilding className="min-h-screen" />
        </div>
      )}
    </DisputeDraftOverlayContext.Provider>
  );
}

export function useDisputeDraftOverlay(): DisputeDraftOverlayContextValue {
  const ctx = useContext(DisputeDraftOverlayContext);
  if (!ctx) {
    throw new Error(
      "useDisputeDraftOverlay must be used inside DisputeDraftOverlayProvider",
    );
  }
  return ctx;
}
