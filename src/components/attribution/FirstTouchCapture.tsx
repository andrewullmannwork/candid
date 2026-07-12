"use client";

import { useEffect } from "react";
import { captureFirstTouch } from "@/lib/attribution/first-touch";

/**
 * FirstTouchCapture — mounts once in the root layout and snapshots the
 * arrival channel (UTM/referrer) into localStorage on the user's first
 * landing. Renders nothing; fail-open (see src/lib/attribution/first-touch).
 */
export function FirstTouchCapture() {
  useEffect(() => {
    captureFirstTouch();
  }, []);
  return null;
}
