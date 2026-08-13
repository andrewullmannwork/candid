"use client";

/**
 * use-case-file-download — S305. ONE way to fetch the Case File.
 *
 * There were two hand-rolled copies of the same twelve lines (fetch → blob →
 * anchor → click → revoke): one on the letter page, one in the small-claims
 * panel. Neither reported failure usefully — the small-claims copy swallowed it
 * in an empty catch, and the letter page silently fell back to a legacy
 * per-letter text file, so a user could ask for their Case File, be handed
 * something else, and never be told. A third copy for the claim page would have
 * been the drift; this is the one implementation all of them share.
 *
 * Failure is a returned STATE, not a silent fallback. The caller decides how to
 * show it, but it can no longer decide not to.
 */
import { useCallback, useState } from "react";

export type CaseFileFormat = "pdf" | "text";

export function useCaseFileDownload(getAuthToken: () => Promise<string | null>) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const download = useCallback(
    async (claimId: string, format: CaseFileFormat = "pdf"): Promise<boolean> => {
      if (busy || !claimId) return false;
      setBusy(true);
      setFailed(false);
      try {
        const token = await getAuthToken();
        if (!token) throw new Error("no-auth");
        const res = await fetch(
          `/api/legal/evidence-package?claimId=${encodeURIComponent(claimId)}&format=${format}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!res.ok) throw new Error(`evidence-package ${res.status}`);
        const blob = await res.blob();
        // The filename comes from the server's Content-Disposition when it sends
        // one, so the name a user sees is the name the route chose — one source.
        const disposition = res.headers.get("Content-Disposition") ?? "";
        const named = /filename="([^"]+)"/.exec(disposition)?.[1];
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = named ?? `candid-case-file-${claimId.slice(0, 8)}.${format === "pdf" ? "pdf" : "txt"}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        // S312 (T6b, Andrew) — the download lands on the case record. Emitted
        // HERE because this hook is the ONE implementation every download
        // surface shares (S305) — a per-surface emit is exactly how a fourth
        // surface would someday forget. Fire-and-forget: the record never
        // blocks or fails the artifact the user just received. This event is
        // the future subscription-metering signal (claim-level, format-only
        // payload); the eventual gate lives on the evidence-package route
        // itself — this is the usage record it will read.
        void fetch(`/api/claims/${claimId}/case-events`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "case_file_downloaded", format }),
        }).catch(() => {});
        return true;
      } catch {
        setFailed(true);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, getAuthToken],
  );

  return { download, busy, failed, clearError: useCallback(() => setFailed(false), []) };
}
