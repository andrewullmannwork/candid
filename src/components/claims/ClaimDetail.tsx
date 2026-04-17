"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth/auth-context";
import { Disclaimer } from "@/components/shared/Disclaimer";

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
  metadata: Record<string, unknown>;
  coverageStatus: "covered" | "not_covered" | "unknown" | null;
  planCoverage: {
    covered: boolean | null;
    copay: number | null;
    coinsurance: number | null;
    source: string | null;
  } | null;
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

      {/* Line items table */}
      <div className="bg-white border border-gray-100 rounded-xl overflow-hidden mb-4">
        <div className="grid grid-cols-12 gap-2 px-4 py-2 bg-gray-50 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
          <div className="col-span-4">Service</div>
          <div className="col-span-2">Code</div>
          <div className="col-span-1 text-right">Billed</div>
          <div className="col-span-1 text-right">Paid</div>
          <div className="col-span-1 text-right">You Owe</div>
          <div className="col-span-2 text-center">Coverage</div>
          <div className="col-span-1 text-center">Flags</div>
        </div>

        {data.lineItems.map((item) => {
          const findings = ((item.metadata?.auditFindings || []) as AuditFinding[]);
          const isExpanded = expandedItem === item.id;
          const coverageBadge = item.coverageStatus ? COVERAGE_BADGE[item.coverageStatus] : null;

          // Detect unexplained gap: billed > 0 but nothing paid or owed.
          // Covered lines with this pattern = likely denial or missing allocation.
          const billed = item.billed_amount || 0;
          const paid = item.insurance_paid || 0;
          const owed = item.patient_owes || 0;
          const hasGap = billed > 0 && paid === 0 && owed === 0;
          const gapRelevant = hasGap && item.coverageStatus !== "not_covered";

          return (
            <div key={item.id} data-line-item-id={item.id}>
              <button
                onClick={() => setExpandedItem(isExpanded ? null : item.id)}
                className={`w-full grid grid-cols-12 gap-2 items-center px-4 py-3 text-left transition-colors border-t border-gray-100 ${
                  gapRelevant ? "bg-amber-50/40 hover:bg-amber-50/70" : "hover:bg-gray-50"
                }`}
              >
                <div className="col-span-4 text-xs text-gray-900 truncate">
                  {item.description || item.service_slug?.replace(/_/g, " ") || "Unknown"}
                </div>
                <div className="col-span-2 text-xs text-gray-500 font-mono">
                  {item.billing_code || "—"}
                </div>
                <div className="col-span-1 text-xs text-gray-900 text-right">
                  ${billed.toLocaleString()}
                </div>
                <div className="col-span-1 text-xs text-gray-500 text-right">
                  ${paid.toLocaleString()}
                </div>
                <div className="col-span-1 text-xs font-semibold text-gray-900 text-right">
                  ${owed.toLocaleString()}
                </div>
                <div className="col-span-2 text-center">
                  {coverageBadge && (
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${coverageBadge.className}`}>
                      {coverageBadge.label}
                    </span>
                  )}
                </div>
                <div className="col-span-1 text-center">
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

              {/* Inline gap explanation when expanded and there's a gap */}
              {isExpanded && gapRelevant && findings.length === 0 && (
                <div className="px-4 py-4 bg-amber-50 border-t border-amber-100 space-y-3">
                  {/* Header */}
                  <div>
                    <p className="text-sm font-semibold text-amber-900">
                      Unexplained ${billed.toLocaleString()} charge
                    </p>
                    <p className="mt-1 text-xs text-amber-800">
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
                        ${billed.toLocaleString()} billed · $0 insurance paid · $0 patient owed
                      </p>
                    </div>
                  </div>

                  {/* Actionable steps */}
                  <div className="rounded-lg border border-amber-200 bg-white p-3">
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
                          router.push(`/disputes?letter=${encodeURIComponent(JSON.stringify(result.letter))}`);
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
                            router.push(`/disputes?letter=${encodeURIComponent(JSON.stringify(result.letter))}`);
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

      {/* Linked disputes */}
      {data.disputes.length > 0 && (
        <div className="mb-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-2">Linked Disputes</h3>
          <div className="space-y-2">
            {data.disputes.map((d) => (
              <div key={d.id} className="p-3 bg-white border border-gray-100 rounded-xl flex justify-between items-center">
                <div>
                  <p className="text-xs font-semibold text-gray-900">{d.dispute_type.replace(/_/g, " ")}</p>
                  <p className="text-[10px] text-gray-500">{d.status}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs font-bold">${d.amount_disputed.toLocaleString()}</p>
                  {d.amount_recovered > 0 && (
                    <p className="text-[10px] text-green-600">-${d.amount_recovered.toLocaleString()}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
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
