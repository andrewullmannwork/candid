/**
 * Build the post-generation URL for the /disputes page.
 *
 * Prefers ?dispute=<id> when the API persisted the dispute (so the page
 * runs the always-regen + plan-context + evidence-resolver path on load).
 *
 * Falls back to the legacy ?letter=<encoded JSON> when persistence is off
 * (the `dispute_tracking` flag is disabled, or the request was an itemized-
 * bill request that the persistence path doesn't track).
 */
export function disputeUrlForResult(result: {
  disputeId?: string | null;
  letter?: unknown;
}): string {
  if (result.disputeId) {
    return `/disputes?dispute=${result.disputeId}`;
  }
  if (result.letter !== undefined && result.letter !== null) {
    return `/disputes?letter=${encodeURIComponent(JSON.stringify(result.letter))}`;
  }
  return "/disputes";
}
