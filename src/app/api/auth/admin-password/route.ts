import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const COOKIE_SECRET = process.env.ADMIN_PASSWORD || "candid-admin-fallback";

function makeToken(): string {
  return createHmac("sha256", COOKIE_SECRET).update("admin-authenticated").digest("hex");
}

export function verifyAdminPasswordCookie(cookieValue: string | undefined): boolean {
  if (!cookieValue || !ADMIN_PASSWORD) return false;
  try {
    const expected = makeToken();
    const a = Buffer.from(cookieValue, "utf8");
    const b = Buffer.from(expected, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** POST: Validate admin password and set cookie */
export async function POST(req: NextRequest) {
  if (!ADMIN_PASSWORD) {
    // No password configured — skip gate
    return NextResponse.json({ success: true });
  }

  const { password } = await req.json();
  if (!password || typeof password !== "string") {
    return NextResponse.json({ error: "Password required" }, { status: 400 });
  }

  // Constant-time comparison
  const a = Buffer.from(password, "utf8");
  const b = Buffer.from(ADMIN_PASSWORD, "utf8");
  const match = a.length === b.length && timingSafeEqual(a, b);

  if (!match) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  const token = makeToken();
  const res = NextResponse.json({ success: true });
  res.cookies.set("admin_pw", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 60 * 60 * 24, // 24 hours
    path: "/",
  });

  return res;
}

/** GET: Check if admin password cookie is valid */
export async function GET(req: NextRequest) {
  if (!ADMIN_PASSWORD) {
    // No password configured — always valid
    return NextResponse.json({ authenticated: true });
  }

  const cookie = req.cookies.get("admin_pw")?.value;
  const valid = verifyAdminPasswordCookie(cookie);
  return NextResponse.json({ authenticated: valid });
}
