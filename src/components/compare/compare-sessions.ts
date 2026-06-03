/**
 * Compare v2 (PR5) — localStorage persistence for "Pick up where you left off"
 * (full 2–3 plan comparisons) + single-plan recents.
 *
 * Ref-based: a session stores the resolved PlanRef[] (+ display labels), so
 * restoring re-runs /api/plan/compare against those refs (skip-missing on dangling
 * refs, §9.7) — no File survives localStorage, so an uploaded plan restores via its
 * parsed plan ref. All reads/writes are SSR-safe (guarded on window) and never
 * throw (quota / disabled storage degrades to in-memory empty).
 */
import type { PlanRef } from "@/lib/plan/compare";

const SESSIONS_KEY = "candidCompareSessions_v1";
const RECENTS_KEY = "candidCompareRecents_v1";
const MAX_SESSIONS = 6;
const MAX_RECENTS = 8;

export interface SessionPlan {
  ref: PlanRef;
  name: string;
  sub: string;
}
export interface CompareSession {
  plans: SessionPlan[];
  ts: number;
}
export interface RecentPlan {
  ref: PlanRef;
  name: string;
  sub: string;
  ts: number;
}

function readArray<T>(key: string): T[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? (arr as T[]) : [];
  } catch {
    return [];
  }
}
function writeArray<T>(key: string, list: T[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* quota exceeded / storage disabled — non-fatal */
  }
}

function refKey(r: PlanRef): string {
  return `${r.kind}:${r.id}`;
}
function sessionKey(plans: SessionPlan[]): string {
  return plans.map((p) => refKey(p.ref)).join("|");
}

export function loadSessions(): CompareSession[] {
  return readArray<CompareSession>(SESSIONS_KEY);
}
/** Persist a full comparison (≥2 plans), most-recent first, deduped by plan set. */
export function saveSession(plans: SessionPlan[]): CompareSession[] {
  if (plans.length < 2) return loadSessions();
  const key = sessionKey(plans);
  const next = [{ plans, ts: Date.now() }, ...loadSessions().filter((s) => sessionKey(s.plans) !== key)].slice(
    0,
    MAX_SESSIONS,
  );
  writeArray(SESSIONS_KEY, next);
  return next;
}

export function loadRecents(): RecentPlan[] {
  return readArray<RecentPlan>(RECENTS_KEY);
}
/** Record a single plan the member picked (search/canonical or own), most-recent first. */
export function pushRecent(entry: Omit<RecentPlan, "ts">): RecentPlan[] {
  const key = refKey(entry.ref);
  const next = [{ ...entry, ts: Date.now() }, ...loadRecents().filter((r) => refKey(r.ref) !== key)].slice(
    0,
    MAX_RECENTS,
  );
  writeArray(RECENTS_KEY, next);
  return next;
}
