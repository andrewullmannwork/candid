import { CubeLoaderBuilding } from "@/components/loaders/CubeLoaderBuilding";

/**
 * Next.js route loading boundary for the /disputes segment.
 *
 * S132 iter-8 — unified cube loader. Audit-loader contract retired per
 * Andrew direction "use the checkbox everywhere." Same loader as
 * (app)/loading.tsx — explicit segment loader retained in case future
 * dispute-specific UX wants to override.
 */
export default function DisputesLoading() {
  return <CubeLoaderBuilding />;
}
