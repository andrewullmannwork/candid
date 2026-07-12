/**
 * first-touch — client-side channel-attribution capture (GTM playbook 04).
 *
 * On the user's FIRST landing we snapshot how they arrived (UTM params and/or
 * external referrer host) into localStorage. At signup, auth-context sends the
 * snapshot to /api/auth/sync, which persists it to users.first_touch (mig 203)
 * on the new-user INSERT only — first touch wins, nothing ever overwrites it.
 *
 * PHI posture: first-party only. No cookie, no tracker, no network call from
 * this module — the blob leaves the browser exactly once, inside the signup
 * POST to our own API. Safe to mount on any route (S199 rule concerns
 * third-party analytics; this is neither third-party nor analytics script).
 *
 * Fail-open by design: every path is wrapped — attribution must never break
 * a page render or a signup (private-mode localStorage throws, etc.).
 */

const STORAGE_KEY = "candid_first_touch";

export interface FirstTouch {
  source?: string;
  medium?: string;
  campaign?: string;
  referrer_host?: string;
  landing?: string;
  ts?: string;
}

/** Capture the first touch if none is stored yet. Call once on mount. */
export function captureFirstTouch(): void {
  try {
    if (typeof window === "undefined") return;
    if (window.localStorage.getItem(STORAGE_KEY)) return; // first touch wins

    const params = new URLSearchParams(window.location.search);
    const source = params.get("utm_source") ?? undefined;
    const medium = params.get("utm_medium") ?? undefined;
    const campaign = params.get("utm_campaign") ?? undefined;

    // External referrer host (internal navigations don't count as a touch).
    let referrerHost: string | undefined;
    if (document.referrer) {
      try {
        const host = new URL(document.referrer).hostname;
        if (host && host !== window.location.hostname) referrerHost = host;
      } catch {
        /* malformed referrer — ignore */
      }
    }

    // Nothing attributable (direct visit, no UTMs) → store nothing; the user
    // lands in the NULL = direct/unknown bucket at signup.
    if (!source && !medium && !campaign && !referrerHost) return;

    const touch: FirstTouch = {
      ...(source && { source }),
      ...(medium && { medium }),
      ...(campaign && { campaign }),
      ...(referrerHost && { referrer_host: referrerHost }),
      landing: window.location.pathname,
      ts: new Date().toISOString(),
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(touch));
  } catch {
    /* attribution is best-effort — never surface */
  }
}

/** Read the stored first touch (null when absent/unreadable). */
export function readFirstTouch(): FirstTouch | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as FirstTouch;
  } catch {
    return null;
  }
}
