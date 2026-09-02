"use client";
/**
 * useDfyEntry — ONE public boolean for every surface that shows the
 * done-for-you door (the hero CTA, /appeal-service, the claim page): flag ON
 * AND config `entry_point_enabled`, read from the public endpoint. null while
 * loading, so a page can hold its layout instead of flashing the closed state.
 */
import { useEffect, useState } from "react";

export function useDfyEntry(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/dfy/entry-point")
      .then((r) => r.json())
      .then((j: { enabled?: boolean }) => { if (!cancelled) setEnabled(j.enabled === true); })
      .catch(() => { if (!cancelled) setEnabled(false); });
    return () => { cancelled = true; };
  }, []);
  return enabled;
}
