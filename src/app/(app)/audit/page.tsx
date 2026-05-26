/**
 * /audit — Legacy route superseded by /claim.
 *
 * Session 81 hotfix #3 changed bill upload destination to /claim. The /audit
 * page's per-load processing fallback (pendingAudit sessionStorage) is now
 * redundant because /upload auto-redirects after processing completes.
 *
 * S74.5 D12 (Session 83): redirect /audit → /claim for any user with a
 * bookmark or external link to /audit. Preserves the URL path; transparent
 * to the user. Per Subplan §8 D12 spillover "redirect /audit → /claim for
 * post-MVP" alternative to the AuditReport.parsedBill ↔ claim_line_items
 * shape-divergence fix.
 *
 * If a pendingAudit is still in sessionStorage when /audit loads (the rare
 * race where the user navigated mid-upload), we forward it: process the
 * pending document THEN redirect — preserving the legacy fallback's intent
 * without keeping the duplicate UI shape.
 */
"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { CubeLoaderBuilding } from "@/components/loaders/CubeLoaderBuilding";

export default function AuditPage() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;

    async function processPendingAuditThenRedirect() {
      const raw =
        typeof window !== "undefined"
          ? sessionStorage.getItem("pendingAudit")
          : null;
      if (!raw) {
        router.replace("/claim");
        return;
      }
      try {
        const { documentId, billType } = JSON.parse(raw) as {
          documentId?: string;
          billType?: string;
        };
        sessionStorage.removeItem("pendingAudit");
        if (documentId && billType) {
          // Fire and forget — /claim renders the persisted claim row
          // produced by /api/documents/process. We don't block on the
          // response; the auto-redirect from /upload is the primary
          // path anyway. This branch is the rare manual-navigate race.
          await fetch("/api/documents/process", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ documentId, billType }),
          }).catch(() => {});
        }
      } catch {
        // Corrupt sessionStorage entry; drop it and continue redirect.
        sessionStorage.removeItem("pendingAudit");
      }
      if (cancelled) return;
      router.replace("/claim");
    }

    void processPendingAuditThenRedirect();

    return () => {
      cancelled = true;
    };
  }, [router]);

  return <CubeLoaderBuilding />;
}
