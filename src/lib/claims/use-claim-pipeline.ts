"use client";

/**
 * useClaimPipeline — shared client hook for the claim "money pipeline".
 *
 * Fetches claims + discrepancies + disputes in parallel, synthesizes the
 * client-side review discrepancies (bills where eob_discrepancy_detection
 * didn't run), and derives the per-bill 4-state BillState map — the exact
 * logic that previously lived inline in /claim page.tsx. Extracted for the
 * clarity redesign (Surface 1) so /dashboard's Claim hero and /claim's
 * next-steps tiles read the SAME derived counts — no drift between surfaces.
 *
 * Consumers: /dashboard (Claim hero pipeline stats), /claim (bill list +
 * next-steps tiles).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import {
  deriveBillState,
  type BillState,
  type AuditFinding,
} from "@/lib/claims/derive-bill-state";

// ── Shapes (moved from /claim page.tsx) ─────────────────────────────────────

export interface PipelineDispute {
  id: string;
  disputeType: string;
  status: string;
  amountDisputed: number;
  amountRecovered: number;
  filedDate: string;
  resolutionDate: string | null;
  claimId: string | null;
}

export interface PipelineDisputeData {
  disputes: PipelineDispute[];
  totalRecovered: number;
  activeCount: number;
}

export interface PipelineClaimSummary {
  id: string;
  date_of_service: string | null;
  status: string;
  total_billed: number | null;
  total_patient_responsibility: number | null;
  total_insurance_adjusted?: number | null;
  lineItemCount: number;
  findingCount: number;
  providerName: string;
  created_at: string;
  claim_group_id?: string | null;
  potentialSavings?: number;
  reviewNeededCount?: number;
  /** S290 — live Cost-Share v2 signals from the list route. Non-null ONLY when
   *  the flag is ON and the engine ran; null → legacy derivation unchanged. */
  costShareBillVerdict?: "correct" | "confident" | "insufficient" | "recovery" | null;
  openQuestionCount?: number | null;
  reviewLineItems?: Array<{
    id: string;
    description: string | null;
    billing_code: string | null;
    service_slug: string | null;
    billed_amount: number | null;
  }>;
  topFindings?: Array<{ title: string; estimatedOvercharge: number; billingCode?: string | null }>;
  recovery?: {
    billed: number;
    alreadyPaid: number;
    stillOutstanding: number;
    shouldOwe: number;
    potentialRecovery: number;
    refundComponent: number;
    forgivenessComponent: number;
  };
}

export interface PipelineClaimStats {
  totalBills: number;
  flaggedBills: number;
  totalBilled: number;
  totalPatientResponsibility: number;
  totalPotentialSavings: number;
  totalIssuesFlagged: number;
  totalPotentialRecovery?: number;
  totalRefundComponent?: number;
  totalForgivenessComponent?: number;
  totalAlreadyPaid?: number;
}

/** Aggregate BILL counts by pipeline stage (bills, not line items). */
export interface PipelineCounts {
  /**
   * Bills with a confirmed overcharge, drafted or not. This is the "how many
   * overcharges did we find" total — drafting a letter does not un-find one —
   * so /dashboard's DashDuo reads THIS.
   */
  flagged: number;
  /**
   * Bills with a confirmed overcharge and NO letter yet — the actionable
   * "needs a draft" bucket. S291 (Andrew): a bill must not sit in both
   * "flagged for review" and "dispute ready to send"; once the letter exists
   * the bill belongs to the letters bucket alone. /claim's next-step tile, its
   * Flagged tab count, and that tab's list all read THIS so the three can
   * never disagree.
   */
  needsDraft: number;
  /** Bills with a drafted (non-cancelled) dispute letter. */
  drafted: number;
  /** Bills awaiting user input (needs_review). */
  review: number;
}

export interface ClaimPipeline {
  loading: boolean;
  claims: PipelineClaimSummary[];
  stats: PipelineClaimStats | null;
  disputeData: PipelineDisputeData | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  discrepancies: any[];
  discrepancySummary: { total: number; tier2: number; tier3: number; systemic: number };
  billStates: Map<string, BillState>;
  counts: PipelineCounts;
  totalRecovery: number;
  refetchClaims: () => Promise<void>;
  setDisputeData: (d: PipelineDisputeData | null) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setDiscrepancies: (updater: (prev: any[]) => any[]) => void;
  setDiscrepancySummary: (
    updater: (prev: { total: number; tier2: number; tier3: number; systemic: number }) => {
      total: number;
      tier2: number;
      tier3: number;
      systemic: number;
    },
  ) => void;
}

// ── State derivation (moved verbatim from /claim page.tsx buildBillState) ───

/**
 * Build the BillState for a single claim by translating the existing claim
 * shape into AuditFinding[] consumed by `deriveBillState()`.
 */
export function buildBillState(
  claim: PipelineClaimSummary,
  allDiscrepancies: Array<{ claim_id?: string; tier?: number | null; status?: string | null }>,
  allDisputes: PipelineDispute[],
): BillState {
  const claimDiscrepancies = allDiscrepancies.filter((d) => d.claim_id === claim.id);
  const claimDisputes = allDisputes.filter((d) => d.claimId === claim.id);

  const findings: AuditFinding[] = [];
  // B4.1-FIX1: recovery math is sufficient signal for overcharge — formal audit
  // findings are supplementary, not gating. $10 minimum threshold filters
  // cosmetic deltas from user-actionable overcharges.
  const recovery = claim.recovery?.potentialRecovery ?? claim.potentialSavings ?? 0;
  const OVERCHARGE_THRESHOLD_USD = 10;
  if (recovery > OVERCHARGE_THRESHOLD_USD) {
    findings.push({ severity: "overcharge", recovery_amount: recovery, confidence: 1 });
  }
  if ((claim.reviewNeededCount ?? 0) > 0) {
    findings.push({ severity: "needs_review", confidence: 0.5 });
  }

  // S290 — live-engine supersession. When the list route ran Cost-Share v2
  // (costShareBillVerdict non-null), the persisted tier-2/3 discrepancy rows
  // are an AUDIT-TIME snapshot the user's later answers never touch — feeding
  // them into deriveBillState pinned bills at "needs_review / Answer N
  // questions" forever (the stale-6-questions defect: detail showed a clean
  // recovery verdict while the card read 6 open questions from flagged rows).
  // Uncertainty for v2 bills = the live signals only: an engine verdict of
  // 'insufficient' (data still missing) or unresolved-coverage lines. Legacy
  // bills (verdict null — flag OFF or engine skipped) keep the persisted-row
  // derivation byte-identical.
  const liveVerdict = claim.costShareBillVerdict ?? null;
  if (liveVerdict != null) {
    if (liveVerdict === "insufficient" && findings.every((f) => f.severity !== "needs_review")) {
      findings.push({ severity: "needs_review", confidence: 0.5 });
    }
    return deriveBillState(
      { audit_findings: findings },
      [], // persisted discrepancies superseded by the live engine
      claimDisputes.map((d) => ({ status: d.status })),
    );
  }

  return deriveBillState(
    { audit_findings: findings },
    claimDiscrepancies.map((d) => ({ tier: d.tier ?? null, status: d.status ?? null })),
    claimDisputes.map((d) => ({ status: d.status })),
  );
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useClaimPipeline(): ClaimPipeline {
  const { user } = useAuth();

  const [claims, setClaims] = useState<PipelineClaimSummary[]>([]);
  const [stats, setStats] = useState<PipelineClaimStats | null>(null);
  const [claimsLoading, setClaimsLoading] = useState(true);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [discrepancies, setDiscrepanciesState] = useState<any[]>([]);
  const [discrepancySummary, setDiscrepancySummaryState] = useState({
    total: 0,
    tier2: 0,
    tier3: 0,
    systemic: 0,
  });
  const [discrepanciesLoading, setDiscrepanciesLoading] = useState(true);

  const [disputeData, setDisputeDataState] = useState<PipelineDisputeData | null>(null);
  const [disputesLoading, setDisputesLoading] = useState(true);

  const refetchClaims = useCallback(async () => {
    if (!user) return;
    try {
      const token = await user.firebaseUser.getIdToken();
      const headers = { Authorization: `Bearer ${token}` };

      const [claimsRes, discRes] = await Promise.all([
        fetch("/api/claims", { headers }),
        fetch("/api/claims/discrepancies", { headers }),
      ]);

      const claimsData = claimsRes.ok ? await claimsRes.json() : { claims: [], stats: null };
      setClaims(claimsData.claims || []);
      setStats(claimsData.stats || null);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let persistedDiscrepancies: any[] = [];
      if (discRes.ok) {
        const data = await discRes.json();
        persistedDiscrepancies = data.discrepancies || [];
      }

      // Synthesize "review" discrepancies client-side from claims where
      // eob_discrepancy_detection didn't run (empty claim_discrepancies table).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const synthesized: any[] = [];
      for (const c of (claimsData.claims || []) as PipelineClaimSummary[]) {
        for (const li of c.reviewLineItems || []) {
          const alreadyPersisted = persistedDiscrepancies.some(
            (d) => d.claim_line_item_id === li.id,
          );
          if (alreadyPersisted) continue;
          synthesized.push({
            id: `synth-${li.id}`,
            claim_id: c.id,
            claim_line_item_id: li.id,
            service_slug: li.service_slug || "unknown",
            tier: 2,
            field: "coverage_status",
            expected_value: "Covered — see plan",
            actual_value: `$${(li.billed_amount || 0).toLocaleString()} billed · $0 paid · $0 owed`,
            expected_source: "user_plan",
            expected_confidence: 0.5,
            status: "flagged",
            is_systemic: false,
            systemic_user_count: null,
            metadata: { synthesized: true, providerName: c.providerName, dateOfService: c.date_of_service },
            claim_line_items: {
              description: li.description,
              billing_code: li.billing_code,
              billing_code_type: null,
              billed_amount: li.billed_amount,
              patient_owes: 0,
            },
          });
        }
      }

      const allDiscrepancies = [...persistedDiscrepancies, ...synthesized];
      setDiscrepanciesState(allDiscrepancies);
      setDiscrepancySummaryState({
        total: allDiscrepancies.length,
        tier2: allDiscrepancies.filter((d) => d.tier === 2).length,
        tier3: allDiscrepancies.filter((d) => d.tier === 3).length,
        systemic: allDiscrepancies.filter((d) => d.is_systemic).length,
      });
    } catch (err) {
      console.error("Failed to load data:", err);
    }
    setClaimsLoading(false);
    setDiscrepanciesLoading(false);
  }, [user]);

  useEffect(() => {
    if (!user) return;

    (async () => {
      try {
        const token = await user.firebaseUser.getIdToken();
        const res = await fetch(`/api/disputes/outcome`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const result = await res.json();
          if (result && Array.isArray(result.disputes)) {
            setDisputeDataState(result);
          }
        }
      } catch (err) {
        console.error("Failed to load disputes:", err);
      } finally {
        setDisputesLoading(false);
      }
    })();

    refetchClaims();
  }, [user, refetchClaims]);

  const billStates = useMemo(() => {
    const map = new Map<string, BillState>();
    for (const c of claims) {
      map.set(c.id, buildBillState(c, discrepancies, disputeData?.disputes ?? []));
    }
    return map;
  }, [claims, discrepancies, disputeData]);

  const counts = useMemo<PipelineCounts>(() => {
    const c: PipelineCounts = { flagged: 0, needsDraft: 0, drafted: 0, review: 0 };
    for (const claim of claims) {
      const s = billStates.get(claim.id);
      if (s === "overcharge_no_draft" || s === "overcharge_drafted") c.flagged += 1;
      if (s === "overcharge_no_draft") c.needsDraft += 1;
      if (s === "overcharge_drafted") c.drafted += 1;
      if (s === "needs_review") c.review += 1;
    }
    return c;
  }, [claims, billStates]);

  const totalRecovery = stats?.totalPotentialRecovery ?? stats?.totalPotentialSavings ?? 0;

  return {
    loading: claimsLoading || discrepanciesLoading || disputesLoading,
    claims,
    stats,
    disputeData,
    discrepancies,
    discrepancySummary,
    billStates,
    counts,
    totalRecovery,
    refetchClaims,
    setDisputeData: setDisputeDataState,
    setDiscrepancies: setDiscrepanciesState,
    setDiscrepancySummary: setDiscrepancySummaryState,
  };
}
