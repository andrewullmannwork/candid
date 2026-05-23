"use client";

/**
 * @deprecated S119 B1.3b — renamed to `ShareWithFriend`. Use
 *   `import { ShareWithFriend } from "@/components/share/share-with-friend";`
 * for new call sites. This re-export shim preserves existing call sites
 * (`<ShareCandidCard surface=... />`) so migration can happen surface-by-
 * surface in later batches (B2.4 + B3.1). Drop this file once all call sites
 * have migrated.
 */

export { ShareWithFriend as ShareCandidCard } from "./share-with-friend";
