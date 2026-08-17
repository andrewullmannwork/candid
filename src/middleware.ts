import { NextRequest, NextResponse, type NextFetchEvent } from "next/server";

/** Public routes that don't require authentication */
const PUBLIC_ROUTES = [
  "/",
  "/auth/signin",
  "/auth/signup",
  "/auth/action",
  "/auth/verify-email",
  "/waitlist",
  "/privacy",
  "/terms",
  "/health-data",
  // Public marketing/SEO content surface (/learn + /learn/<slug>). These pages
  // carry no auth and no health data by construction (see LearnChrome), are
  // advertised to crawlers in sitemap.ts, and are deliberately NOT in robots.ts
  // CHD_DISALLOW — gating them behind the auth wall would 307 every indexed URL
  // to the sign-in page and make the content surface unindexable.
  "/learn",
  // Author page — the Person entity every /learn byline links to. Same
  // reasoning as /learn above: behind the auth wall it would 307 to sign-in,
  // which makes the authorship signal worthless (a crawler following the
  // byline hits a login page) and breaks the link for logged-out readers.
  "/about",
  "/api/waitlist",
  "/api/stripe/webhook",
  "/api/auth/sync",
  // S315 — the no-account bill check: a fresh visitor arrives with no session
  // cookie by definition. Flag OFF the page itself redirects home; once the
  // anonymous account exists, sync sets candid_session like any auth path.
  "/check",
  // Dev-only component-preview namespace (S121). Each /dev/* page must guard
  // itself with `if (process.env.NODE_ENV !== "development") notFound();` so the
  // route 404s in PROD builds.
  "/dev",
];

function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(route + "/")
  );
}

// ---------------------------------------------------------------------------
// Server-side pageview counting (mig 204 — GTM P3, /admin/growth "Top pages").
// PHI posture: path-only daily aggregates via increment_pageview() — NO user
// linkage, no cookie, no IP/UA stored. This is NOT client analytics (S199):
// nothing loads in the browser. Fail-open: fired via event.waitUntil with all
// errors swallowed — a missing table/function/env costs nothing and adds no
// latency to the response.
// ---------------------------------------------------------------------------
const NON_PAGE_FILES = new Set([
  "/sitemap.xml",
  "/robots.txt",
  "/llms.txt",
  "/logo.png",
  "/apple-touch-icon.png",
]);

function isCountablePage(pathname: string): boolean {
  return (
    !pathname.startsWith("/api/") &&
    !pathname.startsWith("/_next") &&
    !pathname.startsWith("/favicon") &&
    !pathname.startsWith("/opengraph-image") &&
    !pathname.startsWith("/twitter-image") &&
    !pathname.startsWith("/dev") &&
    // Path counts carry no user linkage (by design), so admin traffic can't be
    // filtered by account — exclude the admin surface itself instead (it's
    // founder-only; counting it is pure noise in "top pages").
    !pathname.startsWith("/admin") &&
    !NON_PAGE_FILES.has(pathname)
  );
}

function countPageview(req: NextRequest, event: NextFetchEvent, pathname: string): void {
  // Production only — local dev + Vercel preview deploys share the same
  // Supabase, and their browsing would pollute the real "Top pages" counts.
  if (process.env.VERCEL_ENV !== "production") return;
  if (req.method !== "GET" || !isCountablePage(pathname)) return;
  // Skip router prefetches (would inflate counts) and obvious crawlers (their
  // visits are tracked where they belong — GSC/Bing, not user pageviews).
  const isPrefetch =
    req.headers.get("next-router-prefetch") !== null ||
    req.headers.get("purpose") === "prefetch" ||
    (req.headers.get("sec-purpose") ?? "").includes("prefetch");
  if (isPrefetch) return;
  const ua = req.headers.get("user-agent") ?? "";
  if (/bot|crawl|spider|slurp|preview|externalhit/i.test(ua)) return;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return;
  event.waitUntil(
    fetch(`${supabaseUrl}/rest/v1/rpc/increment_pageview`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_path: pathname.slice(0, 160) }),
    }).then(
      () => undefined,
      () => undefined, // fail-open — counting must never affect a request
    ),
  );
}

export function middleware(req: NextRequest, event: NextFetchEvent) {
  const { pathname } = req.nextUrl;

  // ---------------------------------------------------------------------------
  // GPC (Global Privacy Control) — CCPA/CPRA compliance
  // When the Sec-GPC header is "1", we treat it as a valid opt-out of the sale
  // or sharing of personal information. We persist it in a first-party cookie so
  // client-side code (consent UI, analytics) can also read it without re-checking
  // the header on every CSR navigation.
  // ---------------------------------------------------------------------------
  const gpcHeader = req.headers.get("sec-gpc");
  let response: NextResponse | undefined;

  // Allow public routes, static assets, API routes, and metadata files
  if (
    isPublicRoute(pathname) ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.startsWith("/api/") ||
    pathname === "/sitemap.xml" ||
    pathname === "/robots.txt" ||
    pathname === "/llms.txt" ||
    pathname === "/logo.png" ||
    pathname === "/apple-touch-icon.png" ||
    pathname.startsWith("/opengraph-image") ||
    pathname.startsWith("/twitter-image")
  ) {
    response = NextResponse.next();
    countPageview(req, event, pathname); // served page → count (mig 204)
  } else {
    // For protected routes, check for Firebase auth cookie/token
    // Note: Full auth verification happens in individual API routes via Firebase Admin SDK.
    // Middleware provides a fast client-side redirect for unauthenticated users.
    // The auth token is stored in localStorage by Firebase client SDK,
    // so server middleware can only check for a session indicator cookie.
    const sessionIndicator = req.cookies.get("candid_session");

    if (!sessionIndicator) {
      // Redirected to / — not a served view of `pathname`; the landing on /
      // counts via its own request.
      const loginUrl = new URL("/", req.url);
      loginUrl.searchParams.set("redirect", pathname);
      response = NextResponse.redirect(loginUrl);
    } else {
      response = NextResponse.next();
      countPageview(req, event, pathname); // served page → count (mig 204)
    }
  }

  // Set GPC cookie if the browser sends the signal
  if (gpcHeader === "1" && !req.cookies.get("candid_gpc")) {
    response.cookies.set("candid_gpc", "1", {
      httpOnly: false, // readable by client JS for consent UI
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: 60 * 60 * 24 * 365, // 1 year
    });
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
