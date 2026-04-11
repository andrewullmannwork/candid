import { NextResponse } from "next/server";

export async function GET() {
  const checks: Record<string, string> = {};

  // Check env vars exist (not their values)
  checks.FIREBASE_ADMIN_SERVICE_ACCOUNT = process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT ? `set (${process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT.length} chars)` : "MISSING";
  checks.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ? "set" : "MISSING";
  checks.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ? "set" : "MISSING";
  checks.NEXT_PUBLIC_FIREBASE_PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "MISSING";
  checks.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || "MISSING";

  // Try to init Firebase Admin
  try {
    const { getAdminAuth } = await import("@/lib/firebase/admin");
    const auth = getAdminAuth();
    checks.firebaseAdmin = auth ? "initialized" : "null";
  } catch (err) {
    checks.firebaseAdmin = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }

  return NextResponse.json(checks);
}
