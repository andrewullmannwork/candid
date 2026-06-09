/**
 * /audit — Legacy route superseded by /claim.
 *
 * Session 81 hotfix #3 changed bill upload destination to /claim. /upload now
 * auto-redirects after processing completes, so the /audit page's per-load
 * processing fallback became redundant.
 *
 * S180 (B9-F01): that fallback issued an UNAUTHENTICATED POST to
 * /api/documents/process. That route now requires auth + ownership, and the
 * primary processing path is /upload → QStash → /api/documents/process-chunk,
 * so the duplicate trigger is removed entirely. /audit now only clears the
 * stale `pendingAudit` marker and redirects to /claim (which renders the
 * persisted claim row) — preserving the redirect intent for any bookmark or
 * mid-upload manual navigation.
 */
"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { CubeLoaderBuilding } from "@/components/loaders/CubeLoaderBuilding";

export default function AuditPage() {
  const router = useRouter();

  useEffect(() => {
    if (typeof window !== "undefined") {
      sessionStorage.removeItem("pendingAudit");
    }
    router.replace("/claim");
  }, [router]);

  return <CubeLoaderBuilding />;
}
