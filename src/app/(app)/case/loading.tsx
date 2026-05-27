import { CubeLoaderBuilding } from "@/components/loaders/CubeLoaderBuilding";

/**
 * Next.js route loading boundary for the /case segment.
 *
 * S132 iter-2 — cross-route nav into /case uses the cube (same rule as
 * /claim per Andrew direction). /case is a coming-soon stub today; this
 * keeps the nav-in transition consistent for when Phase 4.5a launches.
 */
export default function CaseLoading() {
  return <CubeLoaderBuilding />;
}
