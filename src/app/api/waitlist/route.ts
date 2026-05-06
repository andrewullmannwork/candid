import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    {
      error: "Waitlist closed",
      message: "Candid is now open for direct sign-up. Please create an account at /auth/signup.",
    },
    { status: 410 }
  );
}
