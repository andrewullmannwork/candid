import { NextRequest, NextResponse } from "next/server";

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
  "/api/waitlist",
  "/api/stripe/webhook",
  "/api/auth/sync",
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

export function middleware(req: NextRequest) {
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
  } else {
    // For protected routes, check for Firebase auth cookie/token
    // Note: Full auth verification happens in individual API routes via Firebase Admin SDK.
    // Middleware provides a fast client-side redirect for unauthenticated users.
    // The auth token is stored in localStorage by Firebase client SDK,
    // so server middleware can only check for a session indicator cookie.
    const sessionIndicator = req.cookies.get("candid_session");

    if (!sessionIndicator) {
      const loginUrl = new URL("/", req.url);
      loginUrl.searchParams.set("redirect", pathname);
      response = NextResponse.redirect(loginUrl);
    } else {
      response = NextResponse.next();
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
