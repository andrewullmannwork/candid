/**
 * sla — the operator deadline watch, PURE (handoff §3 "deadline watch REUSES the
 * deadline engine"). No new derivation of runway: the cron feeds it the matter
 * summaries the queue already computes, and this module says which matters
 * need a nudge and why. A missed window extinguishes rights — this is the E&O
 * scenario, and the reminder is the cheapest defense.
 */
import type { MatterSummary } from "./matter";

export interface SlaFlag {
  engagementId: string;
  claimId: string;
  memberUserId: string;
  holderUserId: string | null;
  reasons: string[];
  runwayBusinessDays: number | null;
  daysSinceLastAct: number | null;
}

export function daysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : Math.floor((now.getTime() - t) / 86_400_000);
}

/** Active matters that breach the SLA: runway under the refusal threshold, no operator act for `slaDays`, or unclaimed while signed/active. */
export function slaFlags(
  matters: MatterSummary[],
  config: { refusalRunwayBusinessDays: number; slaDays: number },
  now: Date = new Date(),
): SlaFlag[] {
  const out: SlaFlag[] = [];
  for (const m of matters) {
    const e = m.engagement;
    if (e.status !== "active" && e.status !== "signed") continue;
    const reasons: string[] = [];
    if (m.runwayBusinessDays !== null && m.runwayBusinessDays < config.refusalRunwayBusinessDays) {
      reasons.push(`${m.runwayBusinessDays} business days of runway left (threshold ${config.refusalRunwayBusinessDays})`);
    }
    const sinceAct = daysSince(m.lastAct?.occurredAt ?? e.activated_at ?? e.signed_at, now);
    if (e.status === "active" && sinceAct !== null && sinceAct >= config.slaDays) {
      reasons.push(`no operator act for ${sinceAct} days (SLA ${config.slaDays})`);
    }
    if (!e.operator_user_id) reasons.push("unclaimed — no operator holds this matter");
    if (reasons.length) {
      out.push({ engagementId: e.id, claimId: e.claim_id, memberUserId: e.user_id, holderUserId: e.operator_user_id, reasons, runwayBusinessDays: m.runwayBusinessDays, daysSinceLastAct: sinceAct });
    }
  }
  return out;
}
