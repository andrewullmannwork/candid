"use client";

import { Suspense, useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import type { DisputeLetter } from "@/lib/billing/types";
import { useAuth } from "@/lib/auth/auth-context";
import { useSubscription } from "@/lib/subscription/use-subscription";
import { LockedOverlay } from "@/components/shared/LockedOverlay";
import { InlineSubscribePanel } from "@/components/billing/InlineSubscribePanel";
import { downloadCaseFile } from "@/lib/casefile";
import { disputeUrlForResult } from "@/lib/disputes/url";
import { DisputeLetterHero } from "@/components/disputes/DisputeLetterHero";
import { DisputeRecipientCard } from "@/components/disputes/DisputeRecipientCard";
import { EvidenceBlock } from "@/components/disputes/EvidenceBlock";
import { MissingPlanBanner } from "@/components/disputes/MissingPlanBanner";
import { DownloadWarningModal } from "@/components/disputes/DownloadWarningModal";
import { EvidenceGaps } from "@/components/disputes/EvidenceGaps";
import type { PlanContext } from "@/lib/disputes/plan-context";
import type { DisputeEvidence } from "@/lib/disputes/evidence-resolver";

export default function DisputesPage() {
  const { isPro, loading, waitFor } = useSubscription();
  const [subscribing, setSubscribing] = useState(false);

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
      </div>
    );
  }

  if (!isPro) {
    return (
      <LockedOverlay
        title="Dispute Letters requires Candid Pro"
        description="Upgrade to draft appeal letters grounded in your plan benefits, track dispute outcomes, and escalate to the attorney marketplace when needed."
        ctaLabel="Subscribe to Pro"
        onCta={() => setSubscribing(true)}
        tone="pro"
        replaceCta={
          subscribing ? (
            <InlineSubscribePanel
              triggerSurface="dispute"
              subtitle="Unlimited dispute letters, drafted from your plan benefits."
              contextRibbon={{
                headline: "Unlock unlimited dispute letters",
                subline: "Evidence-backed appeal templates drafted from your plan benefits.",
              }}
              onSuccess={async () => {
                // Wait for the webhook to flip tier → pro before dismissing
                // the form. Otherwise LockedOverlay re-renders with the
                // upgrade prompt (tier still reads 'free' in the row the
                // next refresh() fetches).
                await waitFor((s) => s.tier === "pro" && (s.status === "active" || s.status === "trialing"));
                setSubscribing(false);
              }}
              onCancel={() => setSubscribing(false)}
            />
          ) : undefined
        }
      >
        <SampleDisputeLetterPreview />
      </LockedOverlay>
    );
  }

  return (
    <Suspense>
      <DisputesContent />
    </Suspense>
  );
}

/**
 * Background preview rendered behind the upgrade CTA so free users see what
 * a real dispute letter looks like (instead of staring at a blank interstitial).
 */
function SampleDisputeLetterPreview() {
  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">Dispute Letter</h1>
      <p className="text-gray-600 mb-6">
        Review and edit your letter below. When ready, download or copy it and
        send it yourself.
      </p>

      <div className="bg-white rounded-lg shadow p-5 mb-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
          <div>
            <span className="text-gray-500">Type:</span>{" "}
            <span className="font-medium">Appeal to Insurer</span>
          </div>
          <div>
            <span className="text-gray-500">To:</span>{" "}
            <span className="font-medium">Aetna Member Services — Appeals</span>
          </div>
          <div>
            <span className="text-gray-500">Action:</span>{" "}
            <span className="font-medium">Reprocess claim at in-network rate</span>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="font-semibold">Formal Appeal — Claim #AET-2026-0428</h2>
          <div className="flex gap-2">
            <span className="text-sm px-3 py-1.5 rounded border border-gray-300">Edit</span>
            <span className="text-sm px-3 py-1.5 rounded bg-blue-600 text-white">
              Download Case File
            </span>
          </div>
        </div>
        <div className="p-6 whitespace-pre-wrap font-mono text-sm leading-relaxed">
{`Aetna Member Services — Appeals
PO Box 14463
Lexington, KY 40512

Re: Formal appeal of claim denial
Member: Jane Sample · Member ID: W123456789
Date of service: June 1, 2026 · Claim #AET-2026-0428

To Whom It May Concern:

I am appealing the denial of the above claim for an established office visit
(CPT 99214) at Swedish Providence on June 1, 2026. My plan documents (Aetna PPO
Select, plan year 2026) specify a $20 copay for this service when rendered
in-network. The provider is listed as in-network on your published directory.

The EOB shows $428.00 billed, $0.00 insurance paid, and $0.00 patient
responsibility — with no line-item allocation. Per 29 CFR §2560.503-1, I am
entitled to a written explanation of the adverse benefit determination,
including the specific plan provision on which the denial is based.

Community data from anonymized, aggregated Candid user reports shows 14 other
members of this plan have been charged the $20 copay for this service in 2026.
This supports that the denial is inconsistent with plan terms.

I request that this claim be reprocessed at the in-network rate and that I be
credited for the $20 copay I have already paid. Please respond within 30
business days as required by 29 CFR §2560.503-1(i).

Sincerely,
Jane Sample`}
        </div>
      </div>
    </div>
  );
}

function DisputesContent() {
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const [letter, setLetter] = useState<DisputeLetter | null>(() => {
    const letterParam = searchParams.get("letter");
    if (letterParam) {
      try {
        return JSON.parse(decodeURIComponent(letterParam));
      } catch {
        // Invalid letter data
      }
    }
    return null;
  });
  const [editedBody, setEditedBody] = useState(() => {
    const letterParam = searchParams.get("letter");
    if (letterParam) {
      try {
        const parsed = JSON.parse(decodeURIComponent(letterParam));
        return parsed.body || "";
      } catch {
        // Invalid letter data
      }
    }
    return "";
  });
  const [disputeFetching, setDisputeFetching] = useState(false);
  const [planContext, setPlanContext] = useState<PlanContext | null>(null);
  const [evidence, setEvidence] = useState<DisputeEvidence | null>(null);
  const [missingPlanDismissed, setMissingPlanDismissed] = useState(false);
  const [downloadWarnOpen, setDownloadWarnOpen] = useState(false);
  const [nameMismatch, setNameMismatch] = useState<{ billName: string; profileName: string } | null>(null);
  const disputeId = searchParams.get("dispute");

  // Fetch dispute + plan context + evidence (reused for refetch-on-focus).
  const fetchDispute = useCallback(async (id: string) => {
    if (!user) return;
    const token = await user.firebaseUser.getIdToken();
    const res = await fetch(`/api/disputes/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    setPlanContext(data.planContext ?? null);
    setEvidence(data.evidence ?? null);
    setNameMismatch(data.patientNameMismatch ?? null);
    if (data.letterContent) {
      const synthesized: DisputeLetter = {
        id: data.id,
        auditReportId: data.claimId || "",
        userId: "",
        letterType: (data.disputeType === "internal_appeal" ? "insurance_appeal" : data.disputeType) || "insurance_appeal",
        findingIds: [],
        recipient: recipientFromPlanContext(data.planContext),
        subject: `Formal appeal — dispute ${data.id.slice(0, 8)}`,
        body: data.letterContent,
        supportingFacts: [],
        requestedAction: "Reprocess the claim and issue a refund where applicable.",
        status: "draft",
        createdAt: data.filedDate || new Date().toISOString(),
        updatedAt: data.filedDate || new Date().toISOString(),
        planContext: data.planContext?.plan
          ? {
              planName: data.planContext.plan.planName ?? null,
              planYear: data.planContext.plan.planYear ?? null,
              insurerName: data.planContext.insurer?.name ?? data.planContext.plan.insurerName ?? null,
            }
          : null,
        missingPlanForYear: data.missingPlanForYear ?? null,
      };
      setLetter(synthesized);
      setEditedBody(data.letterContent);
    }
  }, [user]);

  // ?dispute=<id> flow — initial fetch.
  useEffect(() => {
    if (!disputeId || letter || !user) return;
    let cancelled = false;
    (async () => {
      setDisputeFetching(true);
      try {
        await fetchDispute(disputeId);
      } catch (err) {
        console.error("Failed to load persisted dispute letter:", err);
      }
      if (!cancelled) setDisputeFetching(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [disputeId, letter, user, fetchDispute]);

  // Phase 7: refetch-on-focus so newly-uploaded historical plans auto-update
  // the letter when the user tabs back.
  useEffect(() => {
    if (!disputeId || !user) return;
    const onFocus = () => {
      fetchDispute(disputeId).catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [disputeId, user, fetchDispute]);

  const [isEditing, setIsEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(editedBody);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      if (textRef.current) {
        textRef.current.select();
        document.execCommand("copy");
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    }
  };

  const handleDownload = () => {
    const blob = new Blob([editedBody], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `candid-dispute-letter-${letter?.letterType || "general"}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleDownloadCaseFile = () => {
    if (!letter) return;
    // Phase 3: warn-not-block when plan missing for claim year.
    const missingYear = letter.missingPlanForYear ?? planContext?.missingForYear ?? null;
    if (missingYear && !missingPlanDismissed) {
      setDownloadWarnOpen(true);
      return;
    }
    // Use the edited body so any user edits are included
    downloadCaseFile({ ...letter, body: editedBody });
  };

  const forceDownloadCaseFile = () => {
    if (!letter) return;
    setDownloadWarnOpen(false);
    downloadCaseFile({ ...letter, body: editedBody });
  };

  const handleConfirmAddress = async (insurerId: string) => {
    if (!user) return;
    const token = await user.firebaseUser.getIdToken();
    await fetch(`/api/disputes/insurer-appeals/confirm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ insurerId, action: "confirmed" }),
    });
    if (disputeId) await fetchDispute(disputeId);
  };

  if (!letter) {
    if (disputeFetching) {
      return (
        <div className="flex min-h-[40vh] items-center justify-center">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
        </div>
      );
    }
    return (
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold mb-6">Dispute Letters</h1>
        <div className="bg-white rounded-lg shadow p-8 text-center">
          <div className="text-6xl mb-4">📝</div>
          <h2 className="text-xl font-semibold mb-2">No letter generated yet</h2>
          <p className="text-gray-600 mb-4">
            Run an{" "}
            <a href="/audit" className="text-blue-600 hover:underline">
              audit on your bill
            </a>{" "}
            first, then select findings to generate a dispute letter.
          </p>
          <p className="text-gray-500 text-sm">
            You can also request an itemized bill without an audit.
          </p>
          <RequestItemizedBill />
        </div>
      </div>
    );
  }

  const missingYear = letter.missingPlanForYear ?? planContext?.missingForYear ?? null;
  const planLabel = planContext?.plan?.planName
    ? `${planContext.plan.planName}${planContext.plan.planYear ? `, ${planContext.plan.planYear}` : ""}`
    : null;
  const providerName = evidence?.claims?.[0]?.providerName ?? null;
  const serviceDate = evidence?.claims?.[0]?.dateOfService ?? letter.createdAt;
  const potentialRecovery = evidence?.totals?.totalDiscrepancy ?? null;
  const letterTypeLabel = LETTER_TYPE_LABELS[letter.letterType] ?? letter.letterType;

  const shortRef = letter.id.slice(0, 8).toUpperCase();

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      {missingYear && !missingPlanDismissed ? (
        <MissingPlanBanner
          claimYear={missingYear}
          disputeId={letter.id}
          onDismiss={() => setMissingPlanDismissed(true)}
        />
      ) : null}

      {/* Important notice — moved to top; softer styling, less boxy */}
      <div className="rounded-xl border border-amber-100 bg-amber-50/70 px-4 py-3 text-xs leading-relaxed text-amber-800">
        <strong className="font-semibold">Important —</strong> Review this letter carefully and make any edits needed. You must send this letter yourself — Candid does not submit letters on your behalf. Consider consulting an attorney if your dispute involves significant amounts.
      </div>

      <DisputeLetterHero
        letter={letter}
        providerName={providerName}
        serviceDate={serviceDate}
        askSummary={buildAskSummary(letter, potentialRecovery)}
        potentialRecovery={potentialRecovery}
      />

      <DisputeRecipientCard
        recipient={letter.recipient}
        insurer={planContext?.insurer ?? null}
        requestedAction={letter.requestedAction}
        letterTypeLabel={letterTypeLabel}
        planYear={planContext?.plan?.planYear ?? null}
        referenceId={letter.id}
        onConfirmAddress={handleConfirmAddress}
      />

      <EvidenceBlock evidence={evidence} planLabel={planLabel} />

      <EvidenceGaps
        gaps={evidence?.gaps ?? []}
        onAuditRerun={
          disputeId
            ? async () => {
                if (!user) return;
                const token = await user.firebaseUser.getIdToken();
                const res = await fetch(
                  `/api/disputes/${disputeId}/rerun-audit`,
                  {
                    method: "POST",
                    headers: { Authorization: `Bearer ${token}` },
                  },
                );
                if (!res.ok) throw new Error("rerun-audit failed");
                await fetchDispute(disputeId);
              }
            : undefined
        }
      />

      {nameMismatch ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 shadow-sm md:flex-row md:items-start md:justify-between">
          <div className="flex flex-1 items-start gap-3">
            <NameMismatchIcon />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-amber-900">
                Verify the patient name before sending
              </div>
              <p className="mt-1 text-sm leading-relaxed text-amber-800">
                We&apos;re using your account name{" "}
                <span className="font-semibold">{nameMismatch.profileName}</span>{" "}
                in the letter. The bill listed{" "}
                <span className="font-semibold">&ldquo;{nameMismatch.billName}&rdquo;</span>{" "}
                — confirm this matches the patient of record. Edit the letter if a
                dependent or family member should be named instead.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setIsEditing(true)}
            className="inline-flex shrink-0 items-center justify-center rounded-lg bg-amber-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-amber-700"
          >
            Edit letter
          </button>
        </div>
      ) : null}

      {/* Toolbar — sticky on scroll; title uses uppercase ref id */}
      <div className="sticky top-4 z-10 rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-white/70">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {letterTypeLabel}
            </div>
            <div className="truncate text-sm font-semibold text-slate-900">
              Formal appeal · Ref {shortRef}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ToolbarButton
              onClick={() => setIsEditing(!isEditing)}
              icon={isEditing ? "preview" : "edit"}
              label={isEditing ? "Preview" : "Edit"}
            />
            <ToolbarButton
              onClick={handleCopy}
              icon="copy"
              label={copied ? "Copied" : "Copy"}
              tone={copied ? "success" : "default"}
            />
            <ToolbarButton
              onClick={handleDownload}
              icon="letter"
              label="Download letter"
            />
          </div>
        </div>
      </div>

      {/* Letter body — paper card, serif, letter-style */}
      <article className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        {isEditing ? (
          <div className="relative">
            <div className="absolute right-4 top-3 text-[11px] font-medium text-slate-400">
              Saved · just now
            </div>
            <textarea
              ref={textRef}
              value={editedBody}
              onChange={(e) => setEditedBody(e.target.value)}
              className="block w-full resize-y bg-transparent px-10 py-12 font-serif text-[15px] leading-[1.7] text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-300/60"
              style={{ minHeight: 620 }}
            />
          </div>
        ) : (
          <div className="whitespace-pre-wrap px-10 py-12 font-serif text-[15px] leading-[1.7] text-slate-900 md:px-14 md:py-14">
            {editedBody}
          </div>
        )}
        {letter.legalBasis ? (
          <div className="border-t border-slate-100 px-10 py-3 text-xs text-slate-500 md:px-14">
            Legal basis referenced: <span className="text-slate-700">{letter.legalBasis}</span>
          </div>
        ) : null}
      </article>

      {/* What to do next — merged Next Steps + Track + Case File download */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm md:p-7">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              What to do next
            </h3>
            <p className="mt-1 text-sm text-slate-600">
              Five steps once your letter looks right. Download the full Case File below.
            </p>
          </div>
        </div>
        <ol className="mt-5 space-y-3.5 text-sm text-slate-700">
          <NextStep n={1} title="Review the letter" body="Scan above and make any edits you want before downloading." />
          <NextStep n={2} title="Send by certified mail" body="Use USPS Form 3811 (return receipt requested) so you have a paper trail." />
          <NextStep n={3} title="Keep your copy" body="File the signed letter and the downloaded Case File with your records." />
          <NextStep n={4} title="Follow up in 30 days" body="Most insurers must respond within 30 days. If they don't, call to escalate." />
          <NextStep
            n={5}
            title="Escalate if unresolved"
            body={
              <>
                Contact your state Insurance Commissioner or a healthcare attorney. Track outcomes on the{" "}
                <a href="/claim" className="font-medium text-blue-600 underline-offset-2 hover:underline">
                  Claims page
                </a>{" "}
                so Candid can improve for everyone.
              </>
            }
          />
        </ol>
      </section>

      {/* Case File download — moved to bottom, single prominent CTA */}
      <section className="rounded-2xl border border-blue-100 bg-gradient-to-br from-blue-50 to-indigo-50 p-6 shadow-sm md:p-7">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-slate-900">Download your full Case File</h3>
            <p className="mt-1 text-sm text-slate-600">
              Dispute letter, audit findings, evidence log, follow-up checklist, and escalation guide — one styled PDF.
            </p>
          </div>
          <button
            type="button"
            onClick={handleDownloadCaseFile}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-px hover:bg-blue-700 hover:shadow"
          >
            <ToolbarIcon name="casefile" />
            Download Case File
          </button>
        </div>
      </section>

      {missingYear ? (
        <DownloadWarningModal
          open={downloadWarnOpen}
          claimYear={missingYear}
          disputeId={letter.id}
          onCancel={() => setDownloadWarnOpen(false)}
          onDownloadAnyway={forceDownloadCaseFile}
        />
      ) : null}
    </div>
  );
}

function NextStep({ n, title, body }: { n: number; title: string; body: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">
        {n}
      </span>
      <div className="min-w-0">
        <div className="font-semibold text-slate-900">{title}</div>
        <div className="text-slate-600">{body}</div>
      </div>
    </li>
  );
}

const LETTER_TYPE_LABELS: Record<DisputeLetter["letterType"], string> = {
  insurance_appeal: "Appeal to Insurer",
  overcharge: "Billing Dispute",
  balance_billing: "Balance Billing Dispute",
  duplicate_charge: "Duplicate Charge Dispute",
  itemized_request: "Itemized Bill Request",
  negotiation: "Self-Pay Negotiation",
};

function buildAskSummary(letter: DisputeLetter, recovery: number | null): string | null {
  if (letter.requestedAction) return letter.requestedAction;
  if (recovery && recovery > 0) {
    return `Requesting ${formatUsd(recovery)} be reprocessed at plan terms.`;
  }
  return null;
}

function formatUsd(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return `$${rounded.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function NameMismatchIcon() {
  return (
    <svg
      className="mt-0.5 h-5 w-5 shrink-0 text-amber-600"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
      aria-hidden
    >
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

// Small icon set (stroke-based, matches Lucide aesthetic without the dep).
function ToolbarIcon({ name }: { name: "edit" | "preview" | "copy" | "letter" | "casefile" }) {
  const common = { className: "h-4 w-4", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, viewBox: "0 0 24 24" };
  switch (name) {
    case "edit":
      return (
        <svg {...common}>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4 12.5-12.5z" />
        </svg>
      );
    case "preview":
      return (
        <svg {...common}>
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    case "copy":
      return (
        <svg {...common}>
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
      );
    case "letter":
      return (
        <svg {...common}>
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
        </svg>
      );
    case "casefile":
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
      );
  }
}

function ToolbarButton({
  onClick,
  icon,
  label,
  tone = "default",
}: {
  onClick: () => void;
  icon: React.ComponentProps<typeof ToolbarIcon>["name"];
  label: string;
  tone?: "default" | "primary" | "success";
}) {
  const classes =
    tone === "primary"
      ? "inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-px hover:bg-blue-700 hover:shadow"
      : tone === "success"
      ? "inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700"
      : "inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm transition-all hover:-translate-y-px hover:border-slate-300 hover:shadow";
  return (
    <button type="button" onClick={onClick} className={classes}>
      <ToolbarIcon name={icon} />
      {label}
    </button>
  );
}

function recipientFromPlanContext(
  planContext: (PlanContext & { insurer: { name: string; appealsAddress: { line1: string; line2: string | null; city: string; state: string; postalCode: string } | null; appealsPhone: string | null } | null }) | null,
): DisputeLetter["recipient"] {
  const insurer = planContext?.insurer ?? null;
  if (insurer) {
    const addr = insurer.appealsAddress;
    return {
      name: insurer.name,
      role: "Member Services — Appeals",
      address: addr
        ? [addr.line1, addr.line2, `${addr.city}, ${addr.state} ${addr.postalCode}`].filter(Boolean).join("\n")
        : undefined,
      phone: insurer.appealsPhone ?? undefined,
    };
  }
  return { name: "Insurance Appeals", role: "Appeals Department" };
}

function RequestItemizedBill() {
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({
    patientName: "",
    providerName: "",
    serviceDate: "",
    accountNumber: "",
  });
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch("/api/disputes/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, type: "itemized_request" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      // Itemized-bill requests don't go through the persistence path today
      // (no audit findings → no claim line items to dedupe on), so this
      // generally falls through to the legacy ?letter=<JSON> URL. The shared
      // helper still prefers ?dispute=<id> when persistence is enabled.
      window.location.href = disputeUrlForResult(data);
    } catch {
      alert("Failed to generate letter. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (!show) {
    return (
      <button
        onClick={() => setShow(true)}
        className="mt-4 text-sm text-blue-600 hover:underline"
      >
        Request an itemized bill instead
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6 text-left max-w-md mx-auto space-y-3">
      <input
        type="text"
        placeholder="Your full name"
        required
        value={form.patientName}
        onChange={(e) => setForm({ ...form, patientName: e.target.value })}
        className="w-full border rounded-lg px-3 py-2 text-sm"
      />
      <input
        type="text"
        placeholder="Provider / Hospital name"
        required
        value={form.providerName}
        onChange={(e) => setForm({ ...form, providerName: e.target.value })}
        className="w-full border rounded-lg px-3 py-2 text-sm"
      />
      <input
        type="date"
        required
        value={form.serviceDate}
        onChange={(e) => setForm({ ...form, serviceDate: e.target.value })}
        className="w-full border rounded-lg px-3 py-2 text-sm"
      />
      <input
        type="text"
        placeholder="Account # (optional)"
        value={form.accountNumber}
        onChange={(e) => setForm({ ...form, accountNumber: e.target.value })}
        className="w-full border rounded-lg px-3 py-2 text-sm"
      />
      <button
        type="submit"
        disabled={loading}
        className="w-full bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm"
      >
        {loading ? "Generating..." : "Generate Itemized Bill Request"}
      </button>
    </form>
  );
}
