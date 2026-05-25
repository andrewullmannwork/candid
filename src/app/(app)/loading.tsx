import { CubeLoaderBuilding } from "@/components/loaders/CubeLoaderBuilding";

/**
 * Next.js route loading boundary for the (app) segment.
 *
 * Rendered automatically when navigating between any /(app)/* routes while
 * the destination route is still loading (server components, data fetches,
 * lazy components). Sits inside the (app)/layout.tsx sidebar chrome, so the
 * sidebar stays visible while the content area shows CubeLoaderBuilding.
 *
 * Per S112 §1.C.1 Rec 15 + Andrew direction at B3.1 kickoff: page-navigation
 * loading should use CubeLoaderBuilding (not the prior 5×5 centered spinner).
 */
export default function AppLoading() {
  return <CubeLoaderBuilding />;
}
