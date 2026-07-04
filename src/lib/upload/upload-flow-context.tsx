"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

/**
 * Cost-H (S267) — a tiny shared flag so the /upload page can tell the global
 * ParseCompleteBanner "I'm actively showing my own in-page splash/modal for a
 * doc right now, stand down." When the /upload flow is idle (the user navigated
 * away, or returned to an empty upload form), the banner is free to surface the
 * reading/ready status for a doc processing in the background — which is exactly
 * how a large doc stays visible when the user comes back to /upload.
 *
 * Only /upload writes this (it sets `inPageFlowActive` = its `uploaded` state,
 * and clears it on unmount). Every other page keeps it false, so the banner
 * shows normally there.
 */
interface UploadFlowValue {
  inPageFlowActive: boolean;
  setInPageFlowActive: (active: boolean) => void;
}

const UploadFlowContext = createContext<UploadFlowValue>({
  inPageFlowActive: false,
  setInPageFlowActive: () => {},
});

export function UploadFlowProvider({ children }: { children: ReactNode }) {
  const [inPageFlowActive, setInPageFlowActive] = useState(false);
  const value = useMemo(
    () => ({ inPageFlowActive, setInPageFlowActive }),
    [inPageFlowActive],
  );
  return <UploadFlowContext.Provider value={value}>{children}</UploadFlowContext.Provider>;
}

export function useUploadFlow(): UploadFlowValue {
  return useContext(UploadFlowContext);
}
