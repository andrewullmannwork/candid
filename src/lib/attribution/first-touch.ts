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
const LAST_GUIDE_KEY = "candid_last_guide";

export interface FirstTouch {
  source?: string;
  medium?: string;
  campaign?: string;
  referrer_host?: string;
  landing?: string;
  ts?: string;
  /** Slug of the most recent /learn guide read before signup (see below). */
  last_guide?: string;
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

/**
 * Record the most recently read /learn guide. Unlike the first touch, this is
 * OVERWRITTEN on every guide read — it answers a different question.
 *
 * First touch answers "which channel acquired this person", and it is captured
 * once, on their very first visit. That makes it structurally unable to answer
 * "which article converted them": someone who arrives from Reddit in week one
 * and signs up after reading a guide in week three is recorded as Reddit, with
 * a landing page from three weeks ago. The converting guide leaves no trace.
 *
 * So the two are captured separately and travel together in the same blob:
 * acquisition channel from the first visit, converting guide from the last.
 */
export function captureLastGuide(slug: string): void {
  try {
    if (typeof window === "undefined" || !slug) return;
    window.localStorage.setItem(LAST_GUIDE_KEY, slug);
  } catch {
    /* best-effort — never surface */
  }
}

/**
 * Read the stored first touch, with the last-read guide folded in (null when
 * neither is present). Rides inside the existing `first_touch` JSONB rather
 * than a new column: the blob's shape is ours, and the server already persists
 * it on the new-user INSERT only, which is exactly the moment this fact is
 * true — "the guide this signup last read".
 */
export function readFirstTouch(): FirstTouch | null {
  try {
    if (typeof window === "undefined") return null;

    const raw = window.localStorage.getItem(STORAGE_KEY);
    let touch: FirstTouch = {};
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") touch = parsed as FirstTouch;
    }

    const lastGuide = window.localStorage.getItem(LAST_GUIDE_KEY);
    if (lastGuide) touch = { ...touch, last_guide: lastGuide };

    return Object.keys(touch).length > 0 ? touch : null;
  } catch {
    return null;
  }
}
