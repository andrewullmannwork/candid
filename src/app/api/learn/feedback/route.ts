import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { getAdminAuth } from "@/lib/firebase/admin";

/**
 * POST /api/learn/feedback — "was this article helpful?" votes (S290, mig 214).
 *
 * Public endpoint (the /learn surface is anonymous marketing content;
 * middleware skips /api/*). Identity is OPTIONAL and server-verified: when an
 * Authorization bearer is present we verify the Firebase token and stamp
 * user_id (users PK via firebase_uid) + email; an invalid/absent token just
 * means an anonymous vote — never an error. The client cannot assert identity.
 *
 * Slug validation is by SHAPE, not a content-dir read: this route runs at
 * request time and `content/learn` is only guaranteed present at build (the
 * article pages are SSG) — a filesystem check here could false-404 in the
 * lambda. Junk-but-well-formed slugs land as harmless rows, filterable in
 * aggregate queries.
 *
 * Best-effort per-instance rate limit (in-memory; serverless instances don't
 * share it). Real dedupe is client-side localStorage — this cap only blunts
 * scripted spam per warm lambda.
 */

export const runtime = "nodejs";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;
const rate = new Map<string, { count: number; windowStart: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rate.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    rate.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_MAX;
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (rateLimited(ip)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: { slug?: unknown; helpful?: unknown };
  try {
    body = (await req.json()) as { slug?: unknown; helpful?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const slug = typeof body.slug === "string" ? body.slug : "";
  const helpful = body.helpful;
  if (!SLUG_RE.test(slug) || slug.length > 120 || typeof helpful !== "boolean") {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  // Optional signed-in identity — verified server-side, never trusted from the body.
  let userId: string | null = null;
  let email: string | null = null;
  const authz = req.headers.get("authorization");
  if (authz?.startsWith("Bearer ")) {
    try {
      const decoded = await getAdminAuth().verifyIdToken(authz.slice("Bearer ".length));
      email = decoded.email ?? null;
      const supabase = createServerClient();
      const { data: userRow } = await supabase
        .from("users")
        .select("id")
        .eq("firebase_uid", decoded.uid)
        .maybeSingle();
      userId = (userRow?.id as string | undefined) ?? null;
    } catch {
      // Invalid/expired token → anonymous vote, not an error.
      userId = null;
      email = null;
    }
  }

  const supabase = createServerClient();
  const { error } = await supabase.from("article_feedback").insert({
    article_slug: slug,
    helpful,
    user_id: userId,
    email,
  });
  if (error) {
    console.error("[learn/feedback] insert failed:", error.message);
    return NextResponse.json({ error: "Could not record feedback" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
