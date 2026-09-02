/**
 * GET /api/dfy/entry-point — ONE public boolean: is the member-initiated
 * done-for-you entry point open? (flag ON AND config entry_point_enabled).
 * Reveals nothing else. The landing hero and the service page read it.
 */
import { NextResponse } from "next/server";
import { readDfyState } from "@/lib/dfy/config";

export async function GET() {
  const state = await readDfyState();
  return NextResponse.json({ enabled: state.enabled && state.config.entryPointEnabled });
}
