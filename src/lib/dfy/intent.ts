/**
 * dfy intent — a visitor who arrived at signup from the done-for-you door
 * (/auth/signup?intent=dfy) is walked to the bill upload after onboarding and
 * nudged until they press "Handle my appeal" on the claim (S330, Andrew #3).
 * sessionStorage, try/catch everywhere: absent storage = no intent. A tiny
 * subscribable store so the banner can read it with useSyncExternalStore.
 */
const KEY = "candid_dfy_intent";
const listeners = new Set<() => void>();
function notify(): void { for (const l of listeners) l(); }

export function setDfyIntent(): void {
  try { sessionStorage.setItem(KEY, "1"); } catch { /* no storage */ }
  notify();
}
export function hasDfyIntent(): boolean {
  try { return sessionStorage.getItem(KEY) === "1"; } catch { return false; }
}
export function clearDfyIntent(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* no storage */ }
  notify();
}
export function subscribeDfyIntent(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
export const noDfyIntentOnServer = (): boolean => false;
