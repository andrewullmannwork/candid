/**
 * S322 — render-time upload limits for surfaces whose COPY shows the ceiling
 * (e.g. the compare pickers' "up to NMB"). Starts from the conservative
 * fallback and settles to the live limits once fetched; validation itself
 * should call getUploadLimits()/validateUploadFile at pick time.
 */

"use client";

import { useEffect, useState } from "react";
import { getUploadLimits } from "@/lib/upload/client-upload";
import { FALLBACK_UPLOAD_LIMITS, type UploadLimits } from "@/lib/upload/upload-policy";

export function useUploadLimits(): UploadLimits {
  const [limits, setLimits] = useState<UploadLimits>(FALLBACK_UPLOAD_LIMITS);
  useEffect(() => {
    let alive = true;
    getUploadLimits().then((l) => {
      if (alive) setLimits(l);
    });
    return () => {
      alive = false;
    };
  }, []);
  return limits;
}
