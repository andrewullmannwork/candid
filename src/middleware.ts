import { NextRequest, NextResponse } from "next/server";

/** Public routes that don't require authentication */
const PUBLIC_ROUTES = [
  "/",
  "/auth/signin",
  "/auth/signup",
  "/waitlist",
  "/privacy",
  "/terms",
  "/api/waitlist",
  "/api/stripe/webhook",
  "/api/auth/sync",
];

function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(route + "/")
  );
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow public routes and static assets
  if (
    isPublicRoute(pathname) ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon")
  ) {
    return NextResponse.next();
  }

  // For protected routes, check for Firebase auth cookie/token
  // Note: Full auth verification happens in individual API routes via Firebase Admin SDK.
  // Middleware provides a fast client-side redirect for unauthenticated users.
  // The auth token is stored in localStorage by Firebase client SDK,
  // so server middleware can only check for a session indicator cookie.
  const sessionIndicator = req.cookies.get("candid_session");

  if (!sessionIndicator) {
    const loginUrl = new URL("/", req.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
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
