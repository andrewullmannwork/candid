"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth/auth-context";
import { useSubscription } from "@/lib/subscription/use-subscription";
import { Disclaimer } from "@/components/shared/Disclaimer";
import { disputeUrlForResult } from "@/lib/disputes/url";

interface LineItem {
  id: string;
  line_number: number;
  billing_code: string | null;
  billing_code_type: string | null;
  service_slug: string | null;
  description: string | null;
  units: number;
  billed_amount: number | null;
  allowed_amount: number | null;
  insurance_paid: number | null;
  patient_owes: number | null;
  amount_still_outstanding: number | null;
  metadata: Record<string, unknown>;
  coverageStatus: "covered" | "not_covered" | "unknown" | null;
  planCoverage: {
    covered: boolean | null;
    copay: number | null;
    coinsurance: number | null;
    source: string | null;
  } | null;
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

interface AuditFinding {
  id: string;
  type: string;
  severity: string;
  estimatedOvercharge: number;
  title: string;
  actionable: boolean;
}

interface ClaimData {
  claim: Record<string, unknown>;
  lineItems: LineItem[];
  disputes: Array<{ id: string; dispute_type: string; status: string; amount_disputed: number; amount_recovered: number }>;
  relatedClaims: Array<{ id: string; date_of_service: string; status: string; total_billed: number }>;
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

interface DisputeDetail {
  id: string;
  disputeType: string;
  status: string;
  amountDisputed: number;
  amountRecovered: number;
  filedDate: string | null;
  resolutionDate: string | null;
  claimId: string | null;
  letterContent: string | null;
  evidencePackage: Record<string, unknown> | null;
  lineItems: Array<{
    id: string;
    line_number: number;
    description: string | null;
    billing_code: string | null;
    billed_amount: number | null;
    insurance_paid: number | null;
    patient_owes: number | null;
  }>;
}

const COVERAGE_BADGE: Record<string, { label: string; className: string }> = {
  covered: { label: "Covered", className: "text-green-700 bg-green-50" },
  not_covered: { label: "Not Covered", className: "text-red-700 bg-red-50" },
  unknown: { label: "Unknown", className: "text-gray-500 bg-gray-100" },
};

const SEVERITY_COLORS: Record<string, string> = {
  critical: "text-red-700 bg-red-50 border-red-200",
  high: "text-orange-700 bg-orange-50 border-orange-200",
  medium: "text-amber-700 bg-amber-50 border-amber-200",
  low: "text-yellow-700 bg-yellow-50 border-yellow-200",
};

// Lifecycle labels for disputes. Legacy statuses (filed, in_progress, settled,
// withdrawn, *_on_escalation) still occur in the DB and are mapped here.
const DISPUTE_STATUS_LABEL: Record<string, string> = {
  flagged: "Flagged",
  filed: "Dispute Letter Drafted",
  dispute_letter_drafted: "Dispute Letter Drafted",
  court_documentation_drafted: "Court Documentation Drafted",
  in_progress: "In Progress",
  won: "Won",
  lost: "Lost",
  settled: "Settled",
  withdrawn: "Withdrawn",
  won_on_escalation: "Won (on escalation)",
  settled_on_escalation: "Settled (on escalation)",
};

const DISPUTE_STATUS_BADGE: Record<string, string> = {
  flagged: "text-amber-700 bg-amber-50",
  filed: "text-blue-700 bg-blue-50",
  dispute_letter_drafted: "text-blue-700 bg-blue-50",
  court_documentation_drafted: "text-purple-700 bg-purple-50",
  in_progress: "text-blue-700 bg-blue-50",
  won: "text-green-700 bg-green-50",
  lost: "text-red-700 bg-red-50",
  settled: "text-green-700 bg-green-50",
  withdrawn: "text-gray-600 bg-gray-100",
  won_on_escalation: "text-green-700 bg-green-50",
  settled_on_escalation: "text-green-700 bg-green-50",
};

const DISPUTE_TYPE_LABEL: Record<string, string> = {
  internal_appeal: "Appeal to Insurer",
  external_appeal: "External Appeal",
  complaint: "Regulatory Complaint",
  legal: "Legal Action",
  negotiation: "Self-pay Negotiation",
};

function disputeTypeLabel(type: string): string {
  return (
    DISPUTE_TYPE_LABEL[type] ||
    type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

// Quality-reporting codes (CPT Category II like "3074F" and HCPCS G-codes with
// zero charges) clutter the main breakdown. Hide them in a collapsible section.
function isQualityReporting(item: LineItem, findingCount: number): boolean {
  const code = (item.billing_code || "").toUpperCase();
  const isCatII = /^\d{4}F$/.test(code);
  const billed = item.billed_amount || 0;
  const paid = item.insurance_paid || 0;
  const owed = item.patient_owes || 0;
  const noCharges = billed === 0 && paid === 0 && owed === 0;
  return isCatII || (noCharges && findingCount === 0);
}

export function ClaimDetail({
  claimId,
  onBack,
  focusLineItemId,
  backLabel = "Back to claims",
}: {
  claimId: string;
  onBack: () => void;
  focusLineItemId?: string | null;
  backLabel?: string;
}) {
  const { user } = useAuth();
  const router = useRouter();
  const [data, setData] = useState<ClaimData | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedItem, setExpandedItem] = useState<string | null>(focusLineItemId || null);
  const [disputeLoading, setDisputeLoading] = useState(false);

  // When a focus line item is provided, scroll it into view after data loads.
  // The expanded state is already initialized from focusLineItemId via useState,
  // so we only need the scroll side-effect here (no setState needed).
  useEffect(() => {
    if (!focusLineItemId || !data) return;
    const t = setTimeout(() => {
      const el = document.querySelector(`[data-line-item-id="${focusLineItemId}"]`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 100);
    return () => clearTimeout(t);
  }, [focusLineItemId, data]);

  useEffect(() => {
    if (!user || !claimId) return;

    async function loadClaim() {
      try {
        const token = await user!.firebaseUser.getIdToken();
        const res = await fetch(`/api/claims/${claimId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          setData(await res.json());
        }
      } catch (err) {
        console.error("Failed to load claim:", err);
      }
      setLoading(false);
    }
    loadClaim();
  }, [user, claimId]);

  if (loading) {
    return <div className="p-8 text-center text-sm text-gray-500">Loading claim details...</div>;
  }

  if (!data) {
    return <div className="p-8 text-center text-sm text-gray-500">Claim not found.</div>;
  }

  const claim = data.claim as Record<string, unknown>;
  const providerName = ((claim.metadata as Record<string, unknown>)?.provider as Record<string, unknown>)?.name as string || "Unknown Provider";

  // Split line items — quality-reporting codes (CPT Cat II, zero-charge
  // HCPCS entries) are hidden in a collapsible section so the main breakdown
  // stays focused on actual charges.
  const primaryLineItems: LineItem[] = [];
  const qualityLineItems: LineItem[] = [];
  for (const item of data.lineItems) {
    const findingCount = ((item.metadata?.auditFindings || []) as AuditFinding[]).length;
    if (isQualityReporting(item, findingCount)) qualityLineItems.push(item);
    else primaryLineItems.push(item);
  }

  return (
    <div>
      {/* Back button + header */}
      <button onClick={onBack} className="text-sm text-blue-600 hover:text-blue-700 mb-4 flex items-center gap-1">
        <span>&larr;</span> {backLabel}
      </button>

      <div className="mb-4">
        <h2 className="text-lg font-bold text-gray-900">{providerName}</h2>
        <p className="text-xs text-gray-500">
          {claim.date_of_service as string || "Unknown date"} · {data.lineItems.length} line items · Total: ${((claim.total_billed as number) || 0).toLocaleString()}
        </p>
      </div>

      {/* Related claims */}
      {data.relatedClaims.length > 0 && (
        <div className="mb-4 p-3 bg-blue-50 border border-blue-100 rounded-xl">
          <p className="text-xs font-semibold text-blue-700">
            Related documents ({data.relatedClaims.length}): This bill is linked to other documents from the same provider/date.
          </p>
        </div>
      )}

      {/* Line items table — 7-col layout per user preference.
          Code, Coverage, Flags each get their own column. Numbers right-aligned. */}
      <div className="bg-white border border-gray-100 rounded-xl overflow-hidden mb-4">
        <div className="grid grid-cols-12 gap-4 items-center px-5 py-3 bg-gray-50 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
          <div className="col-span-4">Service</div>
          <div className="col-span-2">Code</div>
          <div className="col-span-1 text-right">Billed</div>
          <div className="col-span-1 text-right">Paid</div>
          <div className="col-span-1 text-right">You Owe</div>
          <div className="col-span-2 text-center">Coverage</div>
          <div className="col-span-1 text-center">Flags</div>
        </div>

        {primaryLineItems.map((item) => {
          const findings = ((item.metadata?.auditFindings || []) as AuditFinding[]);
          const isExpanded = expandedItem === item.id;
          const coverageBadge = item.coverageStatus ? COVERAGE_BADGE[item.coverageStatus] : null;

          // Paid column = derived alreadyPaid (billed − stillOutstanding) so
          // it matches BillCard + ClaimImpactHero at claim level. Falls back
          // to raw insurance_paid for legacy payloads without recovery.
          //
          // hasGap uses RAW insurance_paid because the gap explanation
          // literally says "$X billed · $0 insurance paid · $0 insurance owed"
          // — that's an EOB observation, not a derived number. Using derived
          // `paid` here would hide gaps on any line where the API pro-rated
          // a non-zero "already paid" from the claim header.
          const billed = item.billed_amount || 0;
          const paid = item.recovery?.alreadyPaid ?? (item.insurance_paid || 0);
          const owed = item.patient_owes || 0;
          const rawInsurancePaid = item.insurance_paid || 0;
          const hasGap = billed > 0 && rawInsurancePaid === 0 && owed === 0;
          const gapRelevant = hasGap && item.coverageStatus !== "not_covered";

          return (
            <div key={item.id} data-line-item-id={item.id}>
              <button
                onClick={() => setExpandedItem(isExpanded ? null : item.id)}
                className="w-full grid grid-cols-12 gap-4 items-center px-5 py-3.5 text-left transition-colors border-t border-gray-100 hover:bg-gray-50"
              >
                <div className="col-span-4 text-xs text-gray-900 truncate">
                  {item.description || item.service_slug?.replace(/_/g, " ") || "Unknown"}
                </div>
                <div className="col-span-2 text-xs text-gray-500 font-mono truncate">
                  {item.billing_code || "—"}
                </div>
                <div className="col-span-1 text-xs text-gray-900 text-right tabular-nums">
                  ${billed.toLocaleString()}
                </div>
                <div className="col-span-1 text-xs text-gray-500 text-right tabular-nums">
                  ${paid.toLocaleString()}
                </div>
                <div className="col-span-1 text-xs font-semibold text-gray-900 text-right tabular-nums">
                  ${owed.toLocaleString()}
                </div>
                <div className="col-span-2 flex items-center justify-center">
                  {coverageBadge && (
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${coverageBadge.className}`}>
                      {coverageBadge.label}
                    </span>
                  )}
                </div>
                <div className="col-span-1 flex items-center justify-center">
                  {findings.length > 0 && (
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full text-red-700 bg-red-50">
                      {findings.length}
                    </span>
                  )}
                  {findings.length === 0 && gapRelevant && (
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full text-amber-700 bg-amber-100" title="Billed but nothing paid or owed — likely a denial or missing allocation">
                      Review
                    </span>
                  )}
                </div>
              </button>

              {/* Inline gap explanation when expanded and there's a gap.
                  Amber replaced with white per user preference — colors were
                  too busy. Green "YOUR PLAN SAYS" and red "EOB SHOWS" boxes
                  kept because they carry semantic meaning. */}
              {isExpanded && gapRelevant && findings.length === 0 && (
                <div className="px-4 py-4 bg-white border-t border-gray-100 space-y-3">
                  {/* Header */}
                  <div>
                    <p className="text-sm font-semibold text-gray-900">
                      Unexplained ${billed.toLocaleString()} charge
                    </p>
                    <p className="mt-1 text-xs text-gray-600">
                      {buildGapExplanation(billed, item.planCoverage)}
                    </p>
                  </div>

                  {/* Fact grid: plan says vs EOB says */}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg border border-green-100 bg-green-50 p-2.5">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-green-700">Your plan says</p>
                      <p className="mt-0.5 text-xs font-semibold text-green-900">
                        {buildPlanSays(item.planCoverage)}
                      </p>
                    </div>
                    <div className="rounded-lg border border-red-100 bg-red-50 p-2.5">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-red-700">EOB shows</p>
                      <p className="mt-0.5 text-xs font-semibold text-red-900">
                        ${billed.toLocaleString()} billed · $0 insurance paid · $0 insurance owed
                      </p>
                    </div>
                  </div>

                  {/* Actionable steps */}
                  <div className="rounded-lg border border-gray-200 bg-white p-3">
                    <p className="text-xs font-semibold text-gray-900">How to dispute</p>
                    <ol className="mt-1.5 space-y-1 text-xs text-gray-600">
                      <li>1. Call the insurer claim number on your card and ask why no payment was made for this line.</li>
                      <li>2. If denied, request a written explanation citing the plan provision.</li>
                      <li>3. Draft a formal appeal with the letter below and mail it to the insurer&apos;s appeals address.</li>
                    </ol>
                  </div>

                  {/* Dispute CTA */}
                  <button
                    disabled={disputeLoading}
                    onClick={async (e) => {
                      e.stopPropagation();
                      setDisputeLoading(true);
                      try {
                        const token = await user!.firebaseUser.getIdToken();
                        const claimMeta = data!.claim as Record<string, unknown>;
                        // Synthesize a finding for this gap line so we can reuse the
                        // existing dispute-letter generator (insurance_appeal flow).
                        const syntheticFindingId = `gap-${item.id}`;
                        const syntheticFinding = {
                          id: syntheticFindingId,
                          type: "missing_adjustment",
                          severity: "high",
                          estimatedOvercharge: billed,
                          title: `Unexplained $${billed.toLocaleString()} charge for ${item.description || item.service_slug?.replace(/_/g, " ") || "service"}`,
                          description: `Service covered by plan but EOB records $0 insurance payment and $0 patient responsibility. Provider billed $${billed.toLocaleString()}. Code: ${item.billing_code || "N/A"}.`,
                          actionable: true,
                          billedAmount: billed,
                          lineItems: [item.line_number],
                        };
                        const auditReport = {
                          id: claimId,
                          documentId: (claimMeta.source_document_id as string) || "",
                          userId: (claimMeta.user_id as string) || "",
                          parsedBill: {
                            provider: (claimMeta.metadata as Record<string, unknown>)?.provider || { name: "Unknown" },
                            patient: (claimMeta.metadata as Record<string, unknown>)?.patient || { name: "Unknown" },
                            serviceDate: (claimMeta.date_of_service as string) || "",
                            lineItems: data!.lineItems.map((li) => ({
                              lineNumber: li.line_number,
                              description: li.description,
                              procedureCode: li.billing_code,
                              category: li.service_slug,
                              billedAmount: li.billed_amount || 0,
                              allowedAmount: li.allowed_amount,
                              insurancePaid: li.insurance_paid,
                              patientResponsibility: li.patient_owes,
                            })),
                            totals: {
                              totalBilled: (claimMeta.total_billed as number) || 0,
                              totalAllowed: (claimMeta.total_allowed as number) || undefined,
                              totalInsurancePaid: (claimMeta.total_insurance_paid as number) || undefined,
                              totalPatientResponsibility: (claimMeta.total_patient_responsibility as number) || undefined,
                            },
                          },
                          findings: [syntheticFinding],
                          summary: {
                            totalFindings: 1,
                            totalEstimatedOvercharge: billed,
                            highSeverityCount: 1,
                            actionableCount: 1,
                          },
                          createdAt: new Date().toISOString(),
                        };

                        const res = await fetch("/api/disputes/generate", {
                          method: "POST",
                          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                          body: JSON.stringify({
                            auditReport,
                            findingIds: [syntheticFindingId],
                            letterType: "insurance_appeal",
                            claimId,
                            claimLineItemIds: [item.id],
                            insurancePlanId: (claimMeta.insurance_plan_id as string) || undefined,
                          }),
                        });

                        if (res.ok) {
                          const result = await res.json();
                          router.push(disputeUrlForResult(result));
                        }
                      } catch (err) {
                        console.error("Dispute generation failed:", err);
                      }
                      setDisputeLoading(false);
                    }}
                    className="w-full rounded-lg bg-blue-600 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                  >
                    {disputeLoading ? "Generating letter..." : "Draft dispute letter"}
                  </button>
                </div>
              )}

              {/* Expanded: show findings */}
              {isExpanded && findings.length > 0 && (
                <div className="px-4 py-3 bg-gray-50 border-t border-gray-100 space-y-2">
                  {findings.map((f) => (
                    <div
                      key={f.id}
                      className={`p-3 rounded-lg border text-xs ${SEVERITY_COLORS[f.severity] || "text-gray-700 bg-gray-50 border-gray-200"}`}
                    >
                      <div className="flex justify-between items-start">
                        <div>
                          <p className="font-semibold">{f.title}</p>
                          <p className="mt-0.5 opacity-80">
                            {f.type.replace(/_/g, " ")} · {f.severity}
                          </p>
                        </div>
                        {f.estimatedOvercharge > 0 && (
                          <p className="font-bold shrink-0">
                            -${f.estimatedOvercharge.toLocaleString()}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}

                  {/* Dispute this charge button */}
                  {findings.some((f) => f.actionable) && (
                    <button
                      disabled={disputeLoading}
                      onClick={async (e) => {
                        e.stopPropagation();
                        setDisputeLoading(true);
                        try {
                          const token = await user!.firebaseUser.getIdToken();
                          // Reconstruct minimal audit report from claim metadata
                          const claimMeta = data!.claim as Record<string, unknown>;
                          const auditReport = {
                            id: claimId,
                            documentId: (claimMeta.source_document_id as string) || "",
                            userId: (claimMeta.user_id as string) || "",
                            parsedBill: {
                              provider: (claimMeta.metadata as Record<string, unknown>)?.provider || { name: "Unknown" },
                              patient: (claimMeta.metadata as Record<string, unknown>)?.patient || { name: "Unknown" },
                              serviceDate: (claimMeta.date_of_service as string) || "",
                              lineItems: data!.lineItems.map((li) => ({
                                lineNumber: li.line_number,
                                description: li.description,
                                procedureCode: li.billing_code,
                                category: li.service_slug,
                                billedAmount: li.billed_amount || 0,
                                allowedAmount: li.allowed_amount,
                                insurancePaid: li.insurance_paid,
                                patientResponsibility: li.patient_owes,
                              })),
                              totals: {
                                totalBilled: claimMeta.total_billed as number || 0,
                                totalAllowed: claimMeta.total_allowed as number || undefined,
                                totalInsurancePaid: claimMeta.total_insurance_paid as number || undefined,
                                totalPatientResponsibility: claimMeta.total_patient_responsibility as number || undefined,
                              },
                            },
                            findings: findings.map((f) => ({
                              ...f,
                              billedAmount: item.billed_amount || 0,
                              benchmarkAmount: undefined,
                              description: f.title,
                              lineItems: [item.line_number],
                            })),
                            summary: {
                              totalFindings: findings.length,
                              totalEstimatedOvercharge: findings.reduce((s, f) => s + f.estimatedOvercharge, 0),
                              highSeverityCount: findings.filter((f) => f.severity === "high" || f.severity === "critical").length,
                              actionableCount: findings.filter((f) => f.actionable).length,
                            },
                            createdAt: new Date().toISOString(),
                          };

                          const res = await fetch("/api/disputes/generate", {
                            method: "POST",
                            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                            body: JSON.stringify({
                              auditReport,
                              findingIds: findings.filter((f) => f.actionable).map((f) => f.id),
                              claimId,
                              claimLineItemIds: [item.id],
                              insurancePlanId: (claimMeta.insurance_plan_id as string) || undefined,
                            }),
                          });

                          if (res.ok) {
                            const result = await res.json();
                            router.push(disputeUrlForResult(result));
                          }
                        } catch (err) {
                          console.error("Dispute generation failed:", err);
                        }
                        setDisputeLoading(false);
                      }}
                      className="w-full py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
                    >
                      {disputeLoading ? "Generating..." : "Dispute this charge"}
                    </button>
                  )}

                  {/* Plan coverage details */}
                  {item.planCoverage && (
                    <div className="p-3 rounded-lg border border-blue-200 bg-blue-50 text-xs text-blue-700">
                      <p className="font-semibold">Your plan says:</p>
                      <p>
                        {item.planCoverage.copay != null && `Copay: $${item.planCoverage.copay}`}
                        {item.planCoverage.copay != null && item.planCoverage.coinsurance != null && " · "}
                        {item.planCoverage.coinsurance != null && `Coinsurance: ${(item.planCoverage.coinsurance * 100).toFixed(0)}%`}
                        {!item.planCoverage.copay && !item.planCoverage.coinsurance && "Covered (details not extracted)"}
                      </p>
                      <p className="mt-1 opacity-70">Source: {item.planCoverage.source || "plan document"}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Quality-reporting codes — collapsed by default */}
      {qualityLineItems.length > 0 && (
        <QualityMeasuresSection items={qualityLineItems} />
      )}

      {/* Disputes on this bill — new lifecycle vocabulary, clickable expansion */}
      {data.disputes.length > 0 && (
        <div className="mb-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-2">Disputes</h3>
          <div className="space-y-2">
            {data.disputes.map((d) => (
              <DisputeRow key={d.id} dispute={d} />
            ))}
          </div>
          {/* T2.7 — bundle related bills into one consolidated dispute */}
          <button
            disabled
            className="mt-3 w-full rounded-lg border border-dashed border-gray-200 bg-gray-50/60 px-3 py-2.5 text-left text-xs text-gray-500 cursor-not-allowed"
            title="Coming soon — bundle related bills from the same visit into one consolidated dispute letter."
          >
            <span className="font-semibold text-gray-700">+ Bundle with a related bill</span>
            <span className="ml-2 text-[10px] uppercase tracking-wider text-gray-400">Coming soon</span>
            <span className="mt-0.5 block text-[11px] text-gray-500">
              Group bills from the same visit (hospital + anesthesia + lab + radiology) into one dispute letter.
            </span>
          </button>
        </div>
      )}

      <Disclaimer variant="coverage_check" />
    </div>
  );
}

// ── Copy templates for the unexplained-charge callout ─────────────────────
//
// Each helper returns a string assembled from available fields. Missing data
// causes the corresponding clause or sentence to be omitted — no "undefined",
// no empty interpolations.

function buildGapExplanation(
  billed: number,
  planCoverage: LineItem["planCoverage"],
): string {
  const coverageSentence = planCoverage?.covered !== false
    ? "Your plan covers this service, but the EOB records $0 insurance payment and $0 patient responsibility."
    : "The EOB records $0 insurance payment and $0 patient responsibility.";

  const amountSentence = billed > 0
    ? `The $${billed.toLocaleString()} charge is likely a denial, write-off, or missing EOB data.`
    : "";

  return [coverageSentence, amountSentence].filter(Boolean).join(" ");
}

function buildPlanSays(planCoverage: LineItem["planCoverage"]): string {
  if (!planCoverage) return "Covered (contact insurer to confirm)";
  if (planCoverage.covered === false) return "Not covered";

  const parts: string[] = [];
  if (planCoverage.copay != null) parts.push(`$${planCoverage.copay} copay`);
  if (planCoverage.coinsurance != null) parts.push(`${(planCoverage.coinsurance * 100).toFixed(0)}% coinsurance`);

  if (parts.length === 0) return "Covered";
  return `Covered · ${parts.join(" · ")}`;
}

// ── Quality reporting codes ───────────────────────────────────────────────
//
// CPT Category II and zero-charge HCPCS codes are quality measures that
// clutter the main breakdown. Show a collapsible section so they're
// discoverable without crowding the charges view.

function QualityMeasuresSection({ items }: { items: LineItem[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-4 rounded-xl border border-gray-100 bg-gray-50/60 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-100/60 transition-colors"
      >
        <div>
          <p className="text-xs font-semibold text-gray-700">
            Quality measures ({items.length}) · no charge
          </p>
          <p className="text-[11px] text-gray-500">
            Reporting codes filed alongside the main service. Always $0.
          </p>
        </div>
        <svg
          className={`w-4 h-4 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="border-t border-gray-100 divide-y divide-gray-100">
          {items.map((item) => (
            <div key={item.id} className="grid grid-cols-12 gap-2 px-4 py-2 items-center">
              <div className="col-span-8 text-xs text-gray-600 truncate">
                {item.description || item.service_slug?.replace(/_/g, " ") || "Unknown"}
              </div>
              <div className="col-span-2 text-xs text-gray-500 font-mono">
                {item.billing_code || "—"}
              </div>
              <div className="col-span-2 text-xs text-gray-400 text-right">No charge</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Linked Disputes row ──────────────────────────────────────────────────
//
// Clickable row. Expansion fetches the full dispute (letter text, evidence
// package, linked bill line items) and renders inline with links back to
// /disputes and /small-claims where the full artifacts live.

function DisputeRow({
  dispute,
}: {
  dispute: { id: string; dispute_type: string; status: string; amount_disputed: number; amount_recovered: number };
}) {
  const { user } = useAuth();
  const { isPro } = useSubscription();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<DisputeDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const statusLabel = DISPUTE_STATUS_LABEL[dispute.status] || dispute.status;
  const statusBadgeClass = DISPUTE_STATUS_BADGE[dispute.status] || "text-gray-700 bg-gray-100";
  const typeLabel = disputeTypeLabel(dispute.dispute_type);

  async function toggleOpen() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (detail || detailLoading || !user) return;
    setDetailLoading(true);
    try {
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch(`/api/disputes/${dispute.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setDetail(await res.json());
      }
    } catch (err) {
      console.error("Failed to load dispute detail:", err);
    }
    setDetailLoading(false);
  }

  const hasLetter = !!detail?.letterContent;
  const hasEvidence = !!detail?.evidencePackage;
  const hasReachedLetterStage = dispute.status !== "flagged";
  const hasReachedCourtStage =
    dispute.status === "court_documentation_drafted" ||
    dispute.status === "won" ||
    dispute.status === "lost" ||
    dispute.status === "settled" ||
    dispute.status === "won_on_escalation" ||
    dispute.status === "settled_on_escalation";

  return (
    <div className="rounded-xl border border-gray-100 bg-white overflow-hidden">
      <button
        onClick={toggleOpen}
        className="w-full flex items-center justify-between px-3 py-3 text-left hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${statusBadgeClass}`}>
            {statusLabel}
          </span>
          <div>
            <p className="text-xs font-semibold text-gray-900">{typeLabel}</p>
            <p className="text-[10px] text-gray-500">Click for details</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <p className="text-xs font-bold">${dispute.amount_disputed.toLocaleString()}</p>
            {dispute.amount_recovered > 0 && (
              <p className="text-[10px] text-green-600">+${dispute.amount_recovered.toLocaleString()}</p>
            )}
          </div>
          <svg
            className={`w-4 h-4 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>
      {open && (
        <div className="border-t border-gray-100 p-3 space-y-3 bg-gray-50/40">
          {/* Bill being disputed */}
          <div>
            <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">
              Bill being disputed
            </p>
            {detailLoading && <p className="text-xs text-gray-400">Loading bill details...</p>}
            {!detailLoading && detail && detail.lineItems.length === 0 && (
              <p className="text-xs text-gray-400">No line items linked.</p>
            )}
            {!detailLoading && detail && detail.lineItems.length > 0 && (
              <div className="space-y-1">
                {detail.lineItems.map((li) => (
                  <div key={li.id} className="flex items-center justify-between text-xs text-gray-700">
                    <span className="truncate">
                      {li.description || "Line item"}
                      {li.billing_code && (
                        <span className="ml-2 text-gray-400 font-mono">{li.billing_code}</span>
                      )}
                    </span>
                    <span className="font-semibold ml-2">
                      ${(li.billed_amount || 0).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Letter */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
                Dispute letter
              </p>
              {hasLetter && isPro && (
                <a
                  href={`/disputes?dispute=${dispute.id}`}
                  className="text-[10px] font-semibold text-blue-600 hover:text-blue-700"
                >
                  View full letter →
                </a>
              )}
            </div>
            {hasLetter && isPro ? (
              <pre className="p-2 bg-white border border-gray-100 rounded-lg text-[11px] text-gray-700 whitespace-pre-wrap font-sans line-clamp-4">
                {detail!.letterContent}
              </pre>
            ) : (
              <LetterTeaser
                isPro={isPro}
                hasReachedLetterStage={hasReachedLetterStage}
                disputeId={dispute.id}
              />
            )}
          </div>

          {/* Court documents */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
                Court documentation
              </p>
              {hasEvidence && detail?.claimId && (
                <a
                  href={`/small-claims?claim=${detail.claimId}`}
                  className="text-[10px] font-semibold text-blue-600 hover:text-blue-700"
                >
                  View evidence package →
                </a>
              )}
            </div>
            <p
              className={`p-2 rounded-lg text-xs italic ${
                hasReachedCourtStage && hasEvidence
                  ? "bg-purple-50 text-purple-800 not-italic"
                  : "bg-gray-100 text-gray-400"
              }`}
            >
              {hasEvidence
                ? "9-section court-ready evidence package prepared."
                : hasReachedCourtStage
                  ? "Evidence package reference available on the Small Claims page."
                  : "Evidence not prepared yet."}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Locked letter preview shown when the user can't see the real letter:
 * either because they're on the Free plan, or because this is a legacy
 * dispute that predates letter persistence (letter_content is NULL).
 *
 * Shows a blurred sample letter with an upgrade CTA overlayed so users
 * understand the value of Pro and have a clear path to unlock it.
 */
function LetterTeaser({
  isPro,
  hasReachedLetterStage,
  disputeId,
}: {
  isPro: boolean;
  hasReachedLetterStage: boolean;
  disputeId: string;
}) {
  const sampleLetter = `Aetna Member Services — Appeals
PO Box 14463
Lexington, KY 40512

Re: Formal appeal of claim denial
Member: Jane Sample · Member ID: W123456789
Date of service: June 1, 2026 · Claim #AET-2026-0428

To Whom It May Concern:

I am appealing the denial of the above claim for an established office visit
(CPT 99214) at Swedish Providence. My plan documents specify a $20 copay for
this service when rendered in-network...`;

  return (
    <div className="relative rounded-lg border border-gray-100 overflow-hidden">
      <pre
        aria-hidden
        className="pointer-events-none select-none p-2 bg-white text-[11px] text-gray-700 whitespace-pre-wrap font-sans filter blur-[3px] opacity-60 max-h-32 overflow-hidden"
      >
        {sampleLetter}
      </pre>
      <div className="absolute inset-0 flex items-center justify-center bg-white/50">
        <div className="flex flex-col items-center gap-1.5">
          {!isPro ? (
            <>
              <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
                🔒 Pro only
              </span>
              {/* Route to /disputes?dispute=<id>. That page already has the
                  LockedOverlay billing interstitial (blurred sample letter +
                  Subscribe button → Stripe Checkout). After subscription
                  Stripe redirects back to the same URL, and /disputes picks
                  up the dispute ID to render the real letter. */}
              <a
                href={`/disputes?dispute=${disputeId}`}
                className="px-4 py-1.5 bg-blue-600 text-white text-xs font-semibold rounded-lg hover:bg-blue-700 transition-colors shadow-sm"
              >
                Subscribe to view your dispute letter
              </a>
            </>
          ) : hasReachedLetterStage ? (
            <>
              <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
                Legacy dispute
              </span>
              <p className="text-[11px] text-gray-600 text-center max-w-xs">
                This letter predates text persistence. Regenerate it from the
                bill&apos;s Draft Dispute Letter button to see the text here.
              </p>
            </>
          ) : (
            <p className="text-[11px] text-gray-500 italic">Letter not drafted yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
