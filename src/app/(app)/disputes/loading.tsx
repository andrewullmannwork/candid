import { CodeCarouselLoaderV3 } from "@/components/loaders/CodeCarouselLoaderV3";

/**
 * Next.js route loading boundary for the /disputes segment.
 *
 * B-LOAD.1 follow-up (S131) — Andrew direction: "when I dispute charge and
 * draft letter, it shows BOTH the box loader and the audit loader. Instead,
 * the second I click, load the audit loader."
 *
 * Overrides parent `(app)/loading.tsx` (CubeLoaderBuilding) for the /disputes
 * route segment so the user sees the Audit flow loader from the instant of
 * navigation — no cube flash between click and dispute draft fetch.
 *
 * In-page loading states inside `disputes/page.tsx` (subscription gate,
 * disputeFetching, redrafting) also use CodeCarouselLoaderV3 — one
 * consistent loader visual throughout the dispute draft flow.
 */
export default function DisputesLoading() {
  return <CodeCarouselLoaderV3 title="Drafting your dispute letter" />;
}
