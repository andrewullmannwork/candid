import { CubeLoaderBuilding } from "@/components/loaders/CubeLoaderBuilding";

/**
 * Next.js route loading boundary for the /claim segment.
 *
 * S132 iter-8 — Andrew direction: "use the checkbox everywhere." 2-loader
 * contract (cube + stack). Audit-context-specific loader retired.
 */
export default function ClaimLoading() {
  return <CubeLoaderBuilding />;
}
