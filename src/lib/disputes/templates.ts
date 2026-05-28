// Dispute letter templates — populated with facts from audit findings
// User reviews, edits, approves, and downloads. User sends letter themselves.

import type { AuditFinding, ParsedBill, DisputeLetterType } from "../billing/types";
import type { PlanContext, ProviderContact, AppealsAddress } from "./plan-context";
import type { DisputeEvidence, LineItemEvidence } from "./evidence-resolver";
import { normalizeCoinsurancePct } from "@/lib/billing/coinsurance";

interface LetterTemplate {
  type: DisputeLetterType;
  subject: (provider: string) => string;
  body: (params: TemplateParams) => string;
}

export interface PlanBenefitEvidence {
  serviceSlug: string;
  serviceName: string;
  copay: number | null;
  coinsurance: number | null;
  covered: boolean;
  source: string | null;
}

export interface NetworkEvidenceData {
  serviceName: string;
  memberCount: number;
  medianCost: number;
}

export interface SystemicEvidenceData {
  insurerName: string;
  planName: string;
  serviceName: string;
  affectedMemberCount: number;
}

interface TemplateParams {
  patientName: string;
  providerName: string;
  serviceDate: string;
  accountNumber?: string;
  findings: AuditFinding[];
  bill: ParsedBill;
  planEvidence?: PlanBenefitEvidence[];
  networkEvidence?: NetworkEvidenceData[];
  systemicEvidence?: SystemicEvidenceData;
  codeSubstitutionEvidence?: { deniedCode: string; siblingCode: string; siblingPayRate: number; serviceName: string };
  planContext?: PlanContext | null;
  evidence?: DisputeEvidence | null;
  /**
   * Phase 4 Task 4-E: when consumer_read_filter_v1 flag is ON, dispute letter
   * blockquote rendering is gated by Pattern P-8 cite-grade verification per
   * Q-P4-2 LOCK (legal surface = hide on unverified). Drives the 3-case logic
   * in renderLineItemEvidence per Q-DR-4E-2 LOCK.
   *
   * When false (default; legacy + flag OFF), all blockquotes render unconditionally.
   * When true, only cite-grade-verified excerpts render; non-cite-grade rows fall
   * back to bullet-without-quote (Case 2) or drop bullet entirely (Case 3).
   */
  gateUnverified?: boolean;
}

// ============================================================================
// S74 Pillar 1 — recipient block builders
// ============================================================================
// The OLD letter body hardcoded `${providerName}\nBilling Department` (and the
// equivalent for insurer appeals) — no mailing address. Users printed the letter
// and had nowhere to mail it. These helpers compose the full mailing block so
// the printed page is self-contained.

function formatAppealsAddressBlock(addr: AppealsAddress): string {
  const cityStateZip = [addr.city, addr.state, addr.postalCode]
    .filter(Boolean)
    .join(addr.postalCode ? " " : ", ")
    .replace(`${addr.state} ${addr.postalCode}`, `${addr.state} ${addr.postalCode}`);
  // Build "City, ST 12345"
  const cityLine = [
    [addr.city, addr.state].filter(Boolean).join(", "),
    addr.postalCode,
  ].filter(Boolean).join(" ");
  return [addr.line1, addr.line2, cityLine || cityStateZip].filter(Boolean).join("\n");
}

/** Recipient block for non-appeal letters (mailed to the provider billing dept).
 *  Prefers `planContext.providerContact.address` (loaded from claims.metadata)
 *  but falls back to `bill.provider.address` so audit-only flows that pass an
 *  AuditReport without a persisted claim still render a complete recipient. */
function buildProviderRecipientBlock(
  providerName: string,
  providerContact: ProviderContact | null | undefined,
  bill: ParsedBill | undefined,
): string {
  const lines: string[] = [providerName, "Billing Department"];
  const address = providerContact?.address ?? bill?.provider?.address ?? null;
  if (address) {
    lines.push(address);
  }
  return lines.join("\n");
}

/** Recipient block for insurance-appeal letters (mailed to the insurer appeals dept). */
function buildInsurerRecipientBlock(
  insurerName: string,
  planContext: PlanContext | null | undefined,
): string {
  const lines: string[] = [insurerName, "Member Services — Appeals"];
  const appealsAddress = planContext?.insurer?.appealsAddress;
  if (appealsAddress) {
    lines.push(formatAppealsAddressBlock(appealsAddress));
  }
  const phone = planContext?.insurer?.appealsPhone;
  if (phone) {
    lines.push(`Phone: ${phone}`);
  }
  return lines.join("\n");
}

/** Patient + reference block. Surfaces Provider NPI when it's known —
 *  preferring planContext.providerContact, falling back to bill.provider.npi
 *  for audit-only flows. */
function buildPatientReferenceBlock(
  patientName: string,
  memberId: string | undefined,
  providerContact: ProviderContact | null | undefined,
  bill: ParsedBill | undefined,
): string {
  const parts: string[] = [`Patient: ${patientName}`];
  if (memberId) parts.push(`Member ID: ${memberId}`);
  const npi = providerContact?.npi ?? bill?.provider?.npi ?? null;
  if (npi) parts.push(`Provider NPI: ${npi}`);
  return parts.join("\n");
}

/**
 * S109 PR #2 (Chunk A) — structured claim-identification "Re:" block for the
 * dispute letter header. Designed for the insurer/plan administrator to look
 * up the claim in their system without back-and-forth. Graceful-drop: lines
 * whose source data is null/empty are omitted (no "(unknown)" placeholders).
 *
 * Fields:
 *   - Patient (always present)
 *   - Member ID (skip if absent)
 *   - Date of Service (always present — derived from claim or DoS arg)
 *   - Provider (always present)
 *   - Provider NPI (skip if absent)
 *   - Plan (skip if planContext.plan is null)
 *   - Account # (skip if absent)
 *   - Total Disputed (always present — from evidence.totals.totalDiscrepancy)
 */
function buildClaimIdHeader(params: {
  patientName: string;
  memberId: string | undefined;
  serviceDate: string;
  providerName: string;
  providerContact: ProviderContact | null | undefined;
  bill: ParsedBill | undefined;
  planContext: PlanContext | null | undefined;
  accountNumber: string | undefined;
  evidence: DisputeEvidence | null | undefined;
}): string {
  const npi = params.providerContact?.npi ?? params.bill?.provider?.npi ?? null;
  // S111 smoke #4 — bound canonical surfaces in the Re: header.
  // S111 smoke #6 — when the cited plan's year differs from the bill year
  // (proxy citation), use "Current plan (cited as proxy):" framing instead
  // of "Plan:" — saying "Plan: Anthem 2026" on a 2023 dispute falsely
  // implies the claim was processed under that 2026 plan.
  const exactPlanLabel = params.planContext?.plan?.planName
    ? `${params.planContext.plan.planName}${params.planContext.plan.planYear ? `, plan year ${params.planContext.plan.planYear}` : ""}`
    : null;
  const boundPlanLabel = params.planContext?.boundCanonicalPlan?.planName
    ? `${params.planContext.boundCanonicalPlan.planName}${params.planContext.boundCanonicalPlan.planYear ? `, plan year ${params.planContext.boundCanonicalPlan.planYear}` : ""}`
    : null;
  const planLabel = exactPlanLabel ?? boundPlanLabel;
  const billYear =
    params.planContext?.plan?.planYear ??
    params.planContext?.missingForYear ??
    null;
  const planLabelYear =
    params.planContext?.plan?.planYear ??
    params.planContext?.boundCanonicalPlan?.planYear ??
    null;
  const planLabelIsProxy =
    billYear != null && planLabelYear != null && planLabelYear !== billYear;
  const totalDisputed = params.evidence?.totals?.totalDiscrepancy ?? 0;

  // S109 PR #2 (Chunk A fix) — plain "Label: value" format (no markdown bold
  // markers). The letter preview surface renders text as plain pre-wrap, so
  // `**Label**:` showed as literal asterisks. PDF export is unaffected by the
  // change since the markdown-to-PDF translator handles both formats; plain
  // labels match the surrounding letter style (the original header before
  // this rewrite also used plain labels).
  const lines: string[] = ["Re: Appeal of Adverse Benefit Determination", ""];
  lines.push(`Patient: ${params.patientName}`);
  if (params.memberId) lines.push(`Member ID: ${params.memberId}`);
  lines.push(`Date of Service: ${formatDate(params.serviceDate)}`);
  lines.push(`Provider: ${params.providerName}`);
  if (npi) lines.push(`Provider NPI: ${npi}`);
  if (planLabel) {
    lines.push(
      planLabelIsProxy
        ? `Current plan (cited as proxy): ${planLabel}`
        : `Plan: ${planLabel}`,
    );
  }
  if (params.accountNumber) lines.push(`Account #: ${params.accountNumber}`);
  if (totalDisputed > 0) lines.push(`Total Disputed: ${formatCurrency(totalDisputed)}`);
  return lines.join("\n");
}

/**
 * S109 PR #2 (Chunk A) — escalation-path paragraph for the dispute letter
 * closing. Names the user's state Department of Insurance when known (from
 * profiles.state via PlanContext.userState); falls back to generic copy
 * when state is missing. Tone: assertive-professional, NOT adversarial —
 * cites ACA §2719 + 45 CFR §147.136 external review path. §1132(c)(1)
 * penalty deliberately omitted; held for follow-up letters if insurer
 * fails to respond within the 30-day §1024(b)(4) window.
 */
function buildEscalationParagraph(planContext: PlanContext | null | undefined): string {
  const state = planContext?.userState ?? null;
  const stateClause = state
    ? `the ${state} Department of Insurance`
    : "the applicable state Department of Insurance";
  return `If this matter is not resolved through internal appeal, I intend to pursue external review under ACA §2719 / 45 CFR §147.136 and may file a complaint with ${stateClause}.`;
}

/**
 * S109 PR #2 (Chunk A) — 4-case closing argument for the dispute letter,
 * replacing the prior surrender-language boilerplate. Per the lawyer-pass
 * decision tree in plans/s109_dispute_letter_lawyer_posture.md §3b:
 *
 *   Case A: hasExactPlan + anyPlanBenefit → "" (per-line bullets carry it)
 *   Case B: hasExactPlan + !anyPlanBenefit → §503-1(g) + §503-1(h)(2)(iii)
 *   Case C-fallback: fallback + same-plan confirmed → (Chunk B)
 *   Case C-archive: archiveCanonicalPlan bound → (Chunk B)
 *   Case D: no plan / not confirmed → §503-1(g) + §1024(b)(4) + EOB inconsistency
 *
 * Chunk A only emits Case A, B, and D; fallback-only cases fall to Case D
 * framing until Chunk B adds the same-plan-confirmation banner gate.
 */
function buildClosingArgument(
  planContext: PlanContext | null | undefined,
  evidence: DisputeEvidence | null | undefined,
): string {
  if (!evidence) return "";
  const hasExactPlan = !!planContext?.plan;
  const anyBenefit = hasAnyPlanBenefit(evidence);

  // Case A — per-line cites carry the letter.
  if (hasExactPlan && anyBenefit) return "";

  // Case B — exact plan but no benefit-row matched.
  if (hasExactPlan && !anyBenefit) {
    return "Per 29 CFR §2560.503-1(g), I request a written determination citing the specific plan provision on which any denial is based. Per §2560.503-1(h)(2)(iii), I request reasonable access to and copies of all documents relevant to this claim, including the applicable cost-sharing and coverage provisions.";
  }

  // S110 Chunk C / S111 smoke #6 — Case C-archive: canonical archive (auto-
  // lookup OR manual bind) supplied the cited terms. When the bound
  // canonical's year MATCHES the bill year (community-verified bill-year
  // archive), the per-line bullets carry the cite + closing is the standard
  // §503-1(g) provision-request. When the bound canonical is a WRONG-YEAR
  // proxy (e.g., user bound a 2026 canonical for a 2023 bill), we use a
  // reverse-burden ask similar to Case C-fallback — the cited terms are
  // evidence of CURRENT coverage, and we ask the insurer to produce the
  // bill-year SPD under 29 USC §1024(b)(4) so any year-over-year differences
  // are on them to prove.
  const archiveSourced = !hasExactPlan && anyBenefit && evidence.claims.some((c) =>
    c.lineItemEvidence.some((li) => li.planBenefit?.sourcedFrom === "canonical_archive"),
  );
  if (archiveSourced) {
    const archiveYear = (() => {
      for (const c of evidence.claims) {
        for (const li of c.lineItemEvidence) {
          if (
            li.planBenefit?.sourcedFrom === "canonical_archive" &&
            li.planBenefit?.sourcedFromYear != null
          ) {
            return li.planBenefit.sourcedFromYear;
          }
        }
      }
      return null;
    })();
    const missingYear = planContext?.missingForYear ?? null;
    const archiveIsProxy =
      missingYear != null && archiveYear != null && archiveYear !== missingYear;
    if (!archiveIsProxy) {
      return "Per 29 CFR §2560.503-1(g), I request a written determination citing the specific plan provision on which any denial is based.";
    }
    const yearAskClause = missingYear != null
      ? `To the extent the ${missingYear} plan provisions differ materially from the cited terms, please produce the ${missingYear} Summary Plan Description and plan document under 29 USC §1024(b)(4) within the 30-day statutory period, and identify the specific provision applied to these charges.`
      : "To the extent the plan provisions in effect on the date of service differ materially from the cited terms, please produce the applicable Summary Plan Description and plan document under 29 USC §1024(b)(4) within the 30-day statutory period.";
    return `Per 29 CFR §2560.503-1(g), I request a written determination citing the specific plan provision on which any denial is based. The terms cited above reflect the same plan administered under this insurer, currently in effect. ${yearAskClause}`;
  }

  // S109 PR #2 (Chunk B) — Case C-fallback: same-plan-confirmed proxy cite.
  // Detect by inspecting whether the rendered benefit rows are sourced from
  // 'user_fallback' (the resolver only loads fallback coverage when the user
  // has confirmed same-insurer in the bill year). When true, the per-line
  // bullets already carry "My current plan (year)" framing; the closing
  // argument shifts burden onto the insurer to prove year-over-year drift.
  const fallbackSourced = !hasExactPlan && anyBenefit && evidence.claims.some((c) =>
    c.lineItemEvidence.some((li) => li.planBenefit?.sourcedFrom === "user_fallback"),
  );
  if (fallbackSourced) {
    const fbYear = planContext?.fallbackPlan?.planYear ?? null;
    const missingYear = planContext?.missingForYear ?? null;
    const fbClause = fbYear != null
      ? `My ${fbYear} plan documents are on file with this plan and specify the cost-sharing terms cited above.`
      : "My current plan documents are on file with this plan and specify the cost-sharing terms cited above.";
    const yearAskClause = missingYear != null
      ? `To the extent the ${missingYear} plan provisions differ materially from these terms, please produce the ${missingYear} Summary Plan Description and plan document under 29 USC §1024(b)(4) within the 30-day statutory period, and identify the specific provision applied to these charges.`
      : "To the extent the plan provisions in effect on the date of service differ materially from these terms, please produce the applicable Summary Plan Description and plan document under 29 USC §1024(b)(4) within the 30-day statutory period, and identify the specific provision applied to these charges.";
    return `Per 29 CFR §2560.503-1(g), I request a written determination citing the specific plan provision on which any denial is based. ${fbClause} ${yearAskClause}`;
  }

  // Case D — no plan OR fallback-only without confirmation (Chunk A default).
  // Aggregate EOB math across all claims for the inconsistency framing.
  // S140 — replaced sum-of-nulls reduce with effectiveTotals per claim (cite-grade
  // per-line sum when available; claim-header fallback when per-line sparse).
  // S140 fix-pass H3 — totalBilledAdjusted (= header total_billed minus
  // resolved insurance_adjusted) is the cite-grade dispute anchor; raw
  // gross billed isn't load-bearing for refund/forgive disputes. Citation
  // framing prefix flips to "summary records" when ANY claim's aggregates
  // came from header.
  let totalBilledAdjusted = 0;
  let totalInsurancePaid = 0;
  let totalPatientResp = 0;
  let anyHeaderSourced = false;
  for (const c of evidence.claims) {
    totalBilledAdjusted += Math.max(0, c.totalBilled - c.effectiveTotals.insuranceAdjusted);
    totalInsurancePaid += c.effectiveTotals.insurancePaid;
    totalPatientResp += c.effectiveTotals.patientResponsibility;
    if (
      c.effectiveTotals.provenance.insurancePaidSource === "claim_header" ||
      c.effectiveTotals.provenance.patientResponsibilitySource === "claim_header"
    ) {
      anyHeaderSourced = true;
    }
  }
  const citationPrefix = anyHeaderSourced
    ? "The Explanation of Benefits summary records"
    : "The Explanation of Benefits records";

  const parts: string[] = [
    "Per 29 CFR §2560.503-1(g), I request a written determination citing the specific plan provision on which any denial is based.",
    "Per 29 USC §1024(b)(4), please provide the applicable Summary Plan Description and plan document within the 30-day statutory period.",
  ];
  if (totalBilledAdjusted > 0) {
    parts.push(
      `${citationPrefix} ${formatCurrency(totalInsurancePaid)} insurance paid on a ${formatCurrency(totalBilledAdjusted)} adjusted billed amount, leaving ${formatCurrency(totalPatientResp)} as my responsibility. This treatment warrants a specific provision-level explanation.`,
    );
  }
  return parts.join(" ");
}

// ============================================================================
// Shared "Why this service should be covered" renderer
// ============================================================================
// Returns a formatted block (with trailing blank line) or "" when we don't have
// enough verified evidence to render anything useful. Internal provenance
// markers (source, confidence, k-anonymity counts) gate rendering but never
// appear in the output — see Candid_Data_Patterns.md hard rule 4.

function renderEvidenceBlock(
  evidence: DisputeEvidence | null | undefined,
  planContext: PlanContext | null | undefined,
  title: string = "Why this service should be covered",
  gateUnverified: boolean = false,
): string {
  if (!evidence || evidence.claims.length === 0) return "";

  // Render if we have ANY line items — even without plan-copay matches we
  // can still cite the billing code, EOB math, and request reconsideration
  // per the legal basis. The alternative (no block) makes the letter
  // indistinguishable from a generic form letter.
  const hasAnyLineItems = evidence.claims.some((c) => c.lineItemEvidence.length > 0);
  if (!hasAnyLineItems) return "";

  const multiClaim = evidence.claims.length > 1;
  // S109 PR #2 (Chunk B) — drop markdown `**` markers throughout. Nothing in
  // the preview, download, or PDF path renders markdown, so `**Heading**`
  // showed as literal asterisks. Use UPPERCASE section headers + indentation
  // for visual structure that reads professional as plain text. Pattern P-8
  // verbatim blockquote markers (`> *"..."*`) preserved — those are inside
  // user-facing copy and convey "verbatim quote" semantically.
  const lines: string[] = [title.toUpperCase(), ""];
  let itemNumber = 1;

  for (const claim of evidence.claims) {
    if (multiClaim) {
      const header = [
        claim.providerName ?? "Bill",
        claim.dateOfService ? formatDate(claim.dateOfService) : null,
      ].filter(Boolean).join(" · ");
      lines.push(header, "");
    }

    for (const li of claim.lineItemEvidence) {
      const block = renderLineItemEvidence(li, itemNumber, planContext, gateUnverified);
      if (block) {
        lines.push(block, "");
        itemNumber++;
      }
    }
  }

  // S109 PR #2 (Chunk A) — closing argument + escalation paragraph moved out
  // of renderEvidenceBlock and into insuranceAppealTemplate.body directly.
  // renderEvidenceBlock is shared by provider-bound letters (overcharge,
  // balance_billing, duplicate, itemized_request, negotiation) where the
  // "Plan Administrator" / state-DOI language doesn't fit (those go to the
  // provider's billing department, not the insurer). The 4-case decision
  // tree from the Subplan is insurer-scoped per §4. Per-line bullets here
  // carry the substantive evidence regardless of recipient.

  if (multiClaim) {
    lines.push(
      `Total in dispute across ${evidence.claims.length} bills: ${formatCurrency(evidence.totals.totalDiscrepancy)}`,
      "",
    );
  }

  return lines.join("\n");
}

function hasAnyPlanBenefit(evidence: DisputeEvidence): boolean {
  return evidence.claims.some((c) => c.lineItemEvidence.some((li) => li.planBenefit));
}

function renderLineItemEvidence(
  li: LineItemEvidence,
  index: number,
  planContext: PlanContext | null | undefined,
  gateUnverified: boolean = false,
): string {
  // Bare minimum to render: a code OR a billed amount. Skip phantom items.
  if (!li.billingCode && li.billedAmount === 0 && !li.patientOwes) return "";

  const codeLabel = li.billingCode
    ? `${li.billingCode.type} ${li.billingCode.value}`
    : null;
  // S140 fix-pass H3 — per-line "billed $X" cited only in Case 2 (per-line
  // breakdown available + cite-grade). Per-line gate: insurance_paid AND
  // patient_owes both non-null on this line. Case 1 (sparse per-line)
  // skips the dollar entirely — the aggregate "$X adjusted billed amount"
  // sentence carries the dollar argument; per-line section here just
  // identifies the services and their plan-rule coverage.
  const perLineCitable = li.insurancePaid != null && li.patientOwes != null;
  const headline = [
    `${index}. ${li.serviceName}`,
    codeLabel ? `(${codeLabel})` : null,
    li.billedAmount > 0 && perLineCitable
      ? `— billed ${formatCurrency(li.billedAmount)}`
      : null,
  ].filter(Boolean).join(" ");

  const bullets: string[] = [];

  // Phase 4 Task 4-E: planBenefit-derived bullets are gated by trust level
  // when gateUnverified is true. 3-case logic per Q-DR-4E-2 LOCK:
  //   - Case 1 (cite-grade verified): bullet + verbatim blockquote
  //   - Case 2 (covered + structured cost-sharing populated, no cite-grade): bullet WITHOUT blockquote
  //   - Case 3 (no cite-grade AND no certainty of coverage): drop the planBenefit bullets entirely
  //   - Discrepancy bullet (derived from planBenefit math) gated on the same trust level
  // When gateUnverified === false (legacy / flag OFF), all bullets render unconditionally.
  const planBenefitTrusted = !!(
    li.planBenefit &&
    (!gateUnverified ||
      li.planBenefit.sbcExcerptVerified ||
      (li.planBenefit.covered === true &&
        (li.planBenefit.copay !== null || li.planBenefit.coinsurance !== null)))
  );

  if (li.planBenefit && planBenefitTrusted) {
    // S109 PR #2 (Chunk A) — bullet prefix varies by sourcedFrom per the
    // lawyer-pass decision tree §3a, so the letter discloses honestly which
    // plan data backs the citation (user's exact-year plan vs current-plan-
    // as-proxy vs community-verified canonical archive). Pattern 1 #2 is
    // preserved — we never cite a year we don't have as if it's that year.
    const costDescriptor = li.planBenefit.copay != null
      ? `a ${formatCurrency(li.planBenefit.copay)} copay`
      : li.planBenefit.coinsurance != null
      ? `${normalizeCoinsurancePct(li.planBenefit.coinsurance)}% coinsurance`
      : "cost-sharing terms";

    let prefix: string;
    switch (li.planBenefit.sourcedFrom) {
      case "canonical_archive": {
        // S111 D1/D2 refactor — read from `boundCanonicalPlan` (the canonical
        // the user explicitly bound via PlanSearchModal). Pre-S111 this read
        // from `archiveCanonicalPlan` (auto-discovered Pattern 2 year-shift),
        // but D1 removed that as a citation source — auto-discovery is now
        // UI-suggestion only. Pattern 1 #2 strict enforcement: citations
        // require explicit user binding. The `canonical_archive` sourcedFrom
        // tag now only comes from manual bind (loadCoverageFromCanonical
        // invoked via the canonicalPlanIdForBillYear branch in resolveEvidence).
        const bound = planContext?.boundCanonicalPlan ?? null;
        const insurer =
          bound?.insurerName ??
          planContext?.insurer?.name ??
          planContext?.fallbackPlan?.insurerName ??
          "this plan's";
        const planName = bound?.planName ?? "plan";
        const yearClause = li.planBenefit.sourcedFromYear != null
          ? `${li.planBenefit.sourcedFromYear} Summary of Benefits and Coverage (community-verified)`
          : "Summary of Benefits and Coverage (community-verified)";
        prefix = `Per ${insurer} ${planName} ${yearClause}, this service is covered with ${costDescriptor}`;
        break;
      }
      case "user_fallback": {
        const yearClause = li.planBenefit.sourcedFromYear != null
          ? `My current plan (${li.planBenefit.sourcedFromYear})`
          : "My current plan";
        prefix = `${yearClause} specifies ${costDescriptor} for this service`;
        break;
      }
      case "user_exact":
      default: {
        const planName = planContext?.plan?.planName ?? "Your plan";
        const year = planContext?.plan?.planYear ? `, ${planContext.plan.planYear}` : "";
        prefix = `${planName}${year} specifies ${costDescriptor} for this service`;
        break;
      }
    }
    bullets.push(`   - ${prefix}. Source: ${li.planBenefit.citation}.`);
    // Blockquote (Case 1 only): render the verbatim excerpt only when cite-grade
    // verified OR gating is off entirely (legacy behavior).
    if (li.planBenefit.sbcExcerpt && (!gateUnverified || li.planBenefit.sbcExcerptVerified)) {
      bullets.push(`     > *"${li.planBenefit.sbcExcerpt.trim()}"*`);
    }
  }

  if (li.insurancePaid != null || li.patientOwes != null) {
    // S140 — skip null fields instead of citing as $0 (cite-grade violation).
    // When parser populates only one of (insurance_paid, patient_owes), cite
    // only what we actually have. billedAmount always present.
    const eobParts: string[] = [];
    eobParts.push(`${formatCurrency(li.billedAmount)} billed`);
    if (li.insurancePaid != null) {
      eobParts.push(`${formatCurrency(li.insurancePaid)} insurance paid`);
    }
    if (li.patientOwes != null) {
      eobParts.push(`${formatCurrency(li.patientOwes)} patient responsibility`);
    }
    bullets.push(`   - EOB shows: ${eobParts.join(" · ")}.`);
  }

  if (li.expectedPatientCost != null && li.actualPatientCost != null && planBenefitTrusted) {
    const overage = li.discrepancyAmount ?? 0;
    if (overage > 0) {
      bullets.push(
        `   - Expected patient cost per plan: ${formatCurrency(li.expectedPatientCost)}. Actual patient responsibility: ${formatCurrency(li.actualPatientCost)}. Discrepancy: ${formatCurrency(overage)}.`,
      );
    }
  } else if (li.discrepancyReason && planBenefitTrusted) {
    bullets.push(`   - ${li.discrepancyReason}`);
  } else if (!li.planBenefit && li.patientOwes != null && li.patientOwes > 0) {
    // No plan match — at minimum explain the request crisply.
    bullets.push(
      `   - I request the plan determine the allowed amount for this code and apply the applicable cost-sharing; any amount above my in-network cost-sharing should be written off per plan terms.`,
    );
  }

  // Community outcome bullet — "other claims that have been paid" signal.
  // Already k-anonymity-gated in the resolver (omitted when total_claims < 5).
  if (li.communityOutcome) {
    const c = li.communityOutcome;
    const parts: string[] = [];
    if (c.paidCount > 0) {
      parts.push(`${c.paidCount} of ${c.totalClaims} claims for this code on this plan have been paid`);
    } else {
      parts.push(`${c.totalClaims} claims for this code on this plan are on record`);
    }
    if (c.avgPaidAmount != null && c.paidCount > 0) {
      parts.push(`average payment ${formatCurrency(c.avgPaidAmount)}`);
    }
    bullets.push(`   - ${parts.join("; ")} (anonymized, aggregated Candid member data).`);
  }

  // Sibling-code bullet — "similar procedures but with slightly different
  // billing codes that have been paid." Already filtered to paid siblings.
  if (li.siblingCodes && li.siblingCodes.length > 0) {
    const sibParts = li.siblingCodes
      .slice(0, 3)
      .map((s) =>
        `${s.label} (${s.paidCount}/${s.totalClaims} paid${s.avgPaidAmount != null ? `, avg ${formatCurrency(s.avgPaidAmount)}` : ""})`
      )
      .join("; ");
    bullets.push(
      `   - Related codes in the same service category have been paid on this plan: ${sibParts}. A narrow coding distinction should not justify a blanket denial of this category.`,
    );
  }

  // Pricing benchmark bullet — Care data. Include whenever we have
  // k-anonymous regional data; let the reader judge the gap.
  if (li.pricingBenchmark?.medianBilled != null && li.billedAmount > 0) {
    const pb = li.pricingBenchmark;
    const median = pb.medianBilled!;
    const overageRatio = (li.billedAmount - median) / median;
    const regionSuffix = pb.region ? ` in ${pb.region}` : "";
    const communityPaidSuffix = pb.medianAllowed != null || pb.avgPatientPaid != null
      ? ` Members' insurance typically pays ${pb.medianAllowed != null ? formatCurrency(pb.medianAllowed) : "an undisclosed amount"}${pb.avgPatientPaid != null ? `; the average patient responsibility is ${formatCurrency(pb.avgPatientPaid)}` : ""}.`
      : "";
    if (overageRatio >= 0.1) {
      bullets.push(
        `   - Community benchmark: median billed rate for this code${regionSuffix} is ${formatCurrency(median)} across ${pb.sampleSize} anonymized Candid-member reports. The ${formatCurrency(li.billedAmount)} charged is ${Math.round(overageRatio * 100)}% above that median.${communityPaidSuffix}`,
      );
    } else if (overageRatio > -0.1) {
      bullets.push(
        `   - Community benchmark: median billed rate for this code${regionSuffix} is ${formatCurrency(median)} (n=${pb.sampleSize}), roughly in line with the billed amount.${communityPaidSuffix}`,
      );
    }
  }

  // Audit findings bullet — Medicare benchmark comparison + overcharge /
  // duplicate / upcoding flags captured at claim creation.
  if (li.auditFindings && li.auditFindings.length > 0) {
    for (const f of li.auditFindings) {
      const parts: string[] = [];
      parts.push(`Candid audit flag (${f.title})`);
      if (f.benchmarkAmount != null && f.benchmarkSource) {
        parts.push(`${f.benchmarkSource} benchmark ${formatCurrency(f.benchmarkAmount)}`);
      }
      if (f.estimatedOvercharge > 0) {
        parts.push(`estimated overcharge ${formatCurrency(f.estimatedOvercharge)}`);
      }
      bullets.push(`   - ${parts.join(" · ")}.`);
    }
  }

  // S74.6 D5 — Alternative-code recommendation per Q-S87-D2 Option 1 copy.
  // Letter section requires ≥ 2 corroborated peer codes (excluding the
  // contested line's own code) per Q-S87-C7 letterEligible gate.
  if (li.peerCodes && li.peerCodes.length > 0 && li.billingCode) {
    const filteredPeers = li.peerCodes.filter(
      (p) =>
        !(p.code === li.billingCode!.value && p.codeType === li.billingCode!.type),
    );
    if (filteredPeers.length >= 2) {
      const topPeer = filteredPeers[0];
      bullets.push(
        `   - Note: similar charges have been successfully resolved when re-coded as ${topPeer.code}. Please verify whether ${topPeer.code} more accurately reflects the service provided, and reprocess accordingly if applicable.`,
      );
    }
  }

  return bullets.length > 0 ? [headline, ...bullets].join("\n") : "";
}

function formatDate(iso: string): string {
  // S109 PR #2 (Chunk A fix) — render with timeZone: 'UTC' so ISO dates like
  // "2023-04-25" don't shift to "April 24, 2023" in PT timezone (Date()
  // parses ISO as UTC midnight; toLocaleDateString without timeZone converts
  // back to local timezone, dropping a day for any zone west of UTC).
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

// ============================================================================
// TEMPLATE: Overcharge Dispute
// ============================================================================

const overchargeTemplate: LetterTemplate = {
  type: "overcharge",
  subject: (provider) => `Billing Dispute — Request for Review and Adjustment — ${provider}`,
  body: ({
    patientName,
    providerName,
    serviceDate,
    accountNumber,
    findings,
    planEvidence,
    networkEvidence,
    systemicEvidence,
    codeSubstitutionEvidence,
    planContext,
    evidence,
    gateUnverified,
    bill,
  }) => {
    const findingDetails = findings
      .map(
        (f, i) =>
          `${i + 1}. ${f.title}\n   Billed amount: ${formatCurrency(f.billedAmount)}${f.benchmarkAmount ? `\n   Medicare national average: ${formatCurrency(f.benchmarkAmount)}` : ""}\n   Estimated overcharge: ${formatCurrency(f.estimatedOvercharge)}\n   ${f.description}`
      )
      .join("\n\n");

    const totalOvercharge = findings.reduce(
      (sum, f) => sum + f.estimatedOvercharge,
      0
    );

    const evidenceBlock = renderEvidenceBlock(
      evidence,
      planContext,
      "Supporting evidence for each charge",
      gateUnverified ?? false,
    );

    const recipientBlock = buildProviderRecipientBlock(providerName, planContext?.providerContact, bill);
    const patientRefBlock = buildPatientReferenceBlock(patientName, undefined, planContext?.providerContact, bill);

    return `${formatDate(new Date().toISOString())}

${recipientBlock}

Re: Billing Dispute — Date of Service: ${formatDate(serviceDate)}
${patientRefBlock}${accountNumber ? `\nAccount #: ${accountNumber}` : ""}

To Whom It May Concern:

I am writing to formally dispute charges on my medical bill for services rendered on ${formatDate(serviceDate)}. After reviewing my bill and comparing the charges to publicly available Medicare payment data and standard billing practices, I have identified the following potential discrepancies:

${findingDetails}

The total estimated overcharge across these items is ${formatCurrency(totalOvercharge)}.
${evidenceBlock ? `\n${evidenceBlock}` : ""}
${planEvidence && planEvidence.length > 0 ? `
Additionally, according to my insurance plan documents, the following services are covered under my plan:

${planEvidence.map((pe) => {
  const parts = [`- ${pe.serviceName}`];
  if (pe.copay != null) parts.push(`(plan copay: ${formatCurrency(pe.copay)})`);
  if (pe.coinsurance != null) parts.push(`(plan coinsurance: ${normalizeCoinsurancePct(pe.coinsurance)}%)`);
  if (!pe.copay && !pe.coinsurance) parts.push("(covered)");
  return parts.join(" ");
}).join("\n")}

The charges on my bill exceed my plan's stated cost-sharing terms for these services.
` : ""}${networkEvidence && networkEvidence.length > 0 ? `
Furthermore, based on anonymized, aggregated community data from other plan members:

${networkEvidence.map((ne) => `- ${ne.serviceName}: median patient cost among ${ne.memberCount} members is ${formatCurrency(ne.medianCost)}`).join("\n")}
` : ""}${systemicEvidence ? `
I am one of ${systemicEvidence.affectedMemberCount} members on ${systemicEvidence.planName} who have been charged above plan terms for ${systemicEvidence.serviceName}. This appears to be a systemic pattern by ${systemicEvidence.insurerName}.
` : ""}${codeSubstitutionEvidence ? `
The billing code ${codeSubstitutionEvidence.deniedCode} used on my bill maps to ${codeSubstitutionEvidence.serviceName}, which my plan covers. Code ${codeSubstitutionEvidence.siblingCode} for the same service has been approved ${(codeSubstitutionEvidence.siblingPayRate * 100).toFixed(0)}% of the time on this plan. This suggests either a coding error or a systematic classification discrepancy.
` : ""}
I am requesting the following:

1. A detailed, itemized bill showing all charges, procedure codes (CPT/HCPCS), and quantities.
2. A review and explanation of the charges identified above.
3. An appropriate adjustment to my account if these charges are found to be in error.

Under the No Surprises Act and applicable state consumer protection laws, I am entitled to a clear and accurate bill. I request a written response within 30 days of receipt of this letter.

Please send your response to the address above or contact me to discuss this matter.

Sincerely,

${patientName}

---
DISCLAIMER: This letter was prepared using Candid, a consumer billing analysis tool. Candid is not a law firm, does not provide legal advice, and does not act as your legal representative. The information above is based on anonymized, aggregated community data and publicly available rates, and may not reflect your specific contractual rates or coverage. You should consult with a qualified attorney if you need legal advice regarding your medical bills.`;
  },
};

// ============================================================================
// TEMPLATE: Itemized Bill Request
// ============================================================================

const itemizedRequestTemplate: LetterTemplate = {
  type: "itemized_request",
  subject: (provider) => `Request for Itemized Bill — ${provider}`,
  body: ({ patientName, providerName, serviceDate, accountNumber, planContext, bill }) => {
    const recipientBlock = buildProviderRecipientBlock(providerName, planContext?.providerContact, bill);
    const patientRefBlock = buildPatientReferenceBlock(patientName, undefined, planContext?.providerContact, bill);
    return `${formatDate(new Date().toISOString())}

${recipientBlock}

Re: Request for Itemized Bill — Date of Service: ${formatDate(serviceDate)}
${patientRefBlock}${accountNumber ? `\nAccount #: ${accountNumber}` : ""}

To Whom It May Concern:

I am writing to request a complete itemized bill for services rendered on ${formatDate(serviceDate)}. I am exercising my right under federal and state law to receive a detailed breakdown of all charges.

Please include the following information for each line item:

1. Date of service
2. CPT/HCPCS procedure code
3. Description of the service or supply
4. Quantity
5. Billed amount
6. Insurance-allowed amount (if applicable)
7. Insurance payment (if applicable)
8. Patient responsibility
9. Any adjustments or write-offs applied

Please send the itemized bill to the address above within 30 days of receipt of this request. If there are any questions, please contact me at your earliest convenience.

Sincerely,

${patientName}

---
DISCLAIMER: This letter was prepared using Candid, a consumer billing analysis tool. Candid is not a law firm, does not provide legal advice, and does not act as your legal representative. The information above is based on anonymized, aggregated community data and publicly available rates, and may not reflect your specific contractual rates or coverage.`;
  },
};

// ============================================================================
// TEMPLATE: Insurance Denial Appeal
// ============================================================================

const insuranceAppealTemplate: LetterTemplate = {
  type: "insurance_appeal",
  subject: (provider) => `Appeal of Claim Denial — ${provider}`,
  body: ({
    patientName,
    providerName,
    serviceDate,
    accountNumber,
    bill,
    planContext,
    evidence,
    gateUnverified,
  }) => {
    // S111 smoke #3/#4 — insurer precedence:
    //   1. planContext.insurer (resolved in plan-context.ts preferring
    //      boundCanonicalPlan.insurerName when bound — iteration 3 fix)
    //   2. planContext.boundCanonicalPlan.insurerName (defensive fallback
    //      in case resolveInsurer returned null but the bind succeeded)
    //   3. bill.insurer.name (from EOB metadata)
    //   4. planContext.plan.insurerName (user's plan row)
    //   5. literal placeholder
    const insurerName = planContext?.insurer?.name
      || planContext?.boundCanonicalPlan?.insurerName
      || bill.insurer?.name
      || planContext?.plan?.insurerName
      || "[Insurance Company]";
    const memberId = bill.patient.memberId || undefined;
    // S111 smoke #4/#6 — plan label resolution + wrong-year detection.
    // When the cited plan's year differs from the bill year, we render the
    // sentence as a proxy citation ("citing my current 2026 plan as
    // evidence of present coverage") rather than falsely claiming "this
    // claim was processed under" the wrong-year plan (smoke #6 fix —
    // saying "processed under 2026" on a 2023 dispute is factually wrong
    // and weakens the dispute).
    const exactPlanLabel = planContext?.plan?.planName
      ? `${planContext.plan.planName}${planContext.plan.planYear ? `, plan year ${planContext.plan.planYear}` : ""}`
      : null;
    const boundPlanLabel = planContext?.boundCanonicalPlan?.planName
      ? `${planContext.boundCanonicalPlan.planName}${planContext.boundCanonicalPlan.planYear ? `, plan year ${planContext.boundCanonicalPlan.planYear}` : ""}`
      : null;
    const planLabel = exactPlanLabel ?? boundPlanLabel;
    const billYearForLetter =
      planContext?.plan?.planYear ?? planContext?.missingForYear ?? null;
    const planLabelYear =
      planContext?.plan?.planYear ??
      planContext?.boundCanonicalPlan?.planYear ??
      null;
    const planLabelIsProxy =
      billYearForLetter != null &&
      planLabelYear != null &&
      planLabelYear !== billYearForLetter;
    const planLabelSentence = planLabel
      ? planLabelIsProxy
        ? ` I am citing my current ${planLabel} as evidence of present coverage under this insurer; the plan in effect on the date of service is the subject of the request below.`
        : ` This claim was processed under ${planLabel}.`
      : "";
    const evidenceBlock = renderEvidenceBlock(
      evidence,
      planContext,
      "Why this service should be covered",
      gateUnverified ?? false,
    );

    const recipientBlock = buildInsurerRecipientBlock(insurerName, planContext);

    // S109 PR #2 (Chunk A) — structured claim-id header replaces the prior
    // ad-hoc Re/Patient/Member ID/Provider/Plan/Account# block. Adds Total
    // Disputed; uses graceful-drop for absent fields (no "[Member ID]"
    // placeholders).
    const claimIdHeader = buildClaimIdHeader({
      patientName,
      memberId,
      serviceDate,
      providerName,
      providerContact: planContext?.providerContact,
      bill,
      planContext,
      accountNumber,
      evidence,
    });

    // S109 PR #2 (Chunk A) — 4-case closing argument + escalation paragraph
    // emitted here (NOT inside renderEvidenceBlock) so provider-bound letters
    // don't pick up "Plan Administrator" / state-DOI language. Per Subplan §4
    // this rewrite is localized to insurance_appeal. Removed the duplicate
    // "Under the ACA / §503-1" paragraph that previously followed the
    // evidence block — the closing argument now carries the statutory ask
    // and the escalation paragraph carries the §2719 disclosure.
    const closingArgument = buildClosingArgument(planContext, evidence ?? null);
    const escalationParagraph = buildEscalationParagraph(planContext);

    return `${formatDate(new Date().toISOString())}

${recipientBlock}

${claimIdHeader}

To Whom It May Concern:

I am writing to formally appeal the denial of my claim for services rendered on ${formatDate(serviceDate)} by ${providerName}.${planLabelSentence}

The services provided were medically necessary and should be covered under my plan. I am requesting a full review of this denial, including:

1. The specific reason for denial, including the applicable plan provision or exclusion
2. The clinical criteria used to determine medical necessity
3. Instructions for requesting an external review if this internal appeal is denied

${evidenceBlock ? `${evidenceBlock}` : ""}${closingArgument ? `${closingArgument}\n\n` : ""}${escalationParagraph}

I reserve all rights to pursue any other remedies available under federal and state law.

Sincerely,

${patientName}

---
DISCLAIMER: This letter was prepared using Candid, a consumer billing analysis tool. Candid is not a law firm, does not provide legal advice, and does not act as your legal representative. The information above is based on anonymized, aggregated community data and publicly available rates, and may not reflect your specific contractual rates or coverage. You should consult with a qualified attorney or patient advocate if you need assistance with your insurance appeal.`;
  },
};

// ============================================================================
// TEMPLATE: Balance Billing Dispute
// ============================================================================

const balanceBillingTemplate: LetterTemplate = {
  type: "balance_billing",
  subject: (provider) => `Balance Billing Dispute — ${provider}`,
  body: ({
    patientName,
    providerName,
    serviceDate,
    accountNumber,
    findings,
    planEvidence,
    planContext,
    evidence,
    gateUnverified,
    bill,
  }) => {
    const evidenceBlock = renderEvidenceBlock(
      evidence,
      planContext,
      "Why these charges violate my plan's cost-sharing terms",
      gateUnverified ?? false,
    );
    const findingDetails = findings
      .map(
        (f, i) =>
          `${i + 1}. ${f.title}\n   ${f.description}`
      )
      .join("\n\n");

    const totalExcess = findings.reduce(
      (sum, f) => sum + f.estimatedOvercharge,
      0
    );

    const recipientBlock = buildProviderRecipientBlock(providerName, planContext?.providerContact, bill);
    const patientRefBlock = buildPatientReferenceBlock(patientName, undefined, planContext?.providerContact, bill);

    return `${formatDate(new Date().toISOString())}

${recipientBlock}

Re: Balance Billing Dispute — Date of Service: ${formatDate(serviceDate)}
${patientRefBlock}${accountNumber ? `\nAccount #: ${accountNumber}` : ""}

To Whom It May Concern:

I am writing to dispute what appears to be balance billing on my account for services rendered on ${formatDate(serviceDate)}.

After reviewing my Explanation of Benefits and your bill, I have identified charges that exceed my plan's allowed amount minus my insurance payment. Under the No Surprises Act (effective January 1, 2022) and applicable state balance billing protections, I should not be billed for amounts beyond my in-network cost-sharing obligations for covered services.

Specifically:

${findingDetails}

The total excess charges amount to approximately ${formatCurrency(totalExcess)}.
${evidenceBlock ? `\n${evidenceBlock}\n` : ""}${planEvidence && planEvidence.length > 0 ? `
According to my plan documents, these services are covered with the following cost-sharing terms:

${planEvidence.map((pe) => {
  const parts = [`- ${pe.serviceName}`];
  if (pe.copay != null) parts.push(`(copay: ${formatCurrency(pe.copay)})`);
  if (pe.coinsurance != null) parts.push(`(coinsurance: ${normalizeCoinsurancePct(pe.coinsurance)}%)`);
  return parts.join(" ");
}).join("\n")}

My patient responsibility should be limited to these cost-sharing amounts.
` : ""}
I am requesting:

1. An immediate review of these charges
2. Adjustment of my bill to reflect only my legitimate cost-sharing obligations (copay, coinsurance, and deductible)
3. A corrected bill reflecting the appropriate patient responsibility

Please respond within 30 days. If I do not receive a satisfactory resolution, I intend to file complaints with my state insurance commissioner and the federal No Surprises Help Desk.

Sincerely,

${patientName}

---
DISCLAIMER: This letter was prepared using Candid, a consumer billing analysis tool. Candid is not a law firm, does not provide legal advice, and does not act as your legal representative. The information above is based on anonymized, aggregated community data and publicly available rates, and may not reflect your specific contractual rates or coverage.`;
  },
};

// ============================================================================
// TEMPLATE: Duplicate Charge Dispute
// ============================================================================

const duplicateChargeTemplate: LetterTemplate = {
  type: "duplicate_charge",
  subject: (provider) => `Duplicate Charge Dispute — ${provider}`,
  body: ({
    patientName,
    providerName,
    serviceDate,
    accountNumber,
    findings,
    planContext,
    evidence,
    gateUnverified,
    bill,
  }) => {
    const evidenceBlock = renderEvidenceBlock(
      evidence,
      planContext,
      "Line items flagged as duplicates",
      gateUnverified ?? false,
    );
    const findingDetails = findings
      .map(
        (f, i) =>
          `${i + 1}. ${f.title}\n   ${f.description}`
      )
      .join("\n\n");

    const totalDuplicate = findings.reduce(
      (sum, f) => sum + f.estimatedOvercharge,
      0
    );

    const recipientBlock = buildProviderRecipientBlock(providerName, planContext?.providerContact, bill);
    const patientRefBlock = buildPatientReferenceBlock(patientName, undefined, planContext?.providerContact, bill);

    return `${formatDate(new Date().toISOString())}

${recipientBlock}

Re: Duplicate Charge Dispute — Date of Service: ${formatDate(serviceDate)}
${patientRefBlock}${accountNumber ? `\nAccount #: ${accountNumber}` : ""}

To Whom It May Concern:

I am writing to dispute what appear to be duplicate charges on my medical bill for services rendered on ${formatDate(serviceDate)}.

After reviewing my bill, I have identified the following charges that appear to be duplicated:

${findingDetails}

The total amount of suspected duplicate charges is ${formatCurrency(totalDuplicate)}.
${evidenceBlock ? `\n${evidenceBlock}` : ""}
I am requesting:

1. A detailed review of each charge listed above
2. Removal of any confirmed duplicate charges
3. A corrected bill reflecting the appropriate total

Please provide a written response within 30 days of receipt of this letter.

Sincerely,

${patientName}

---
DISCLAIMER: This letter was prepared using Candid, a consumer billing analysis tool. Candid is not a law firm, does not provide legal advice, and does not act as your legal representative. The information above is based on anonymized, aggregated community data and publicly available rates, and may not reflect your specific contractual rates or coverage.`;
  },
};

// ============================================================================
// TEMPLATE REGISTRY
// ============================================================================

// Negotiation template — uses standalone generator from negotiation-template.ts
// Registered here for type completeness; actual generation via /api/disputes/generate Case 3
const negotiationTemplate: LetterTemplate = {
  type: "negotiation" as DisputeLetterType,
  subject: (provider) => `Self-Pay Rate Negotiation — ${provider}`,
  body: ({ patientName, providerName, serviceDate, planContext, bill }) => {
    const recipientBlock = buildProviderRecipientBlock(providerName, planContext?.providerContact, bill);
    return `${formatDate(new Date().toISOString())}

${recipientBlock}

Re: Self-Pay Rate Negotiation — Date of Service: ${formatDate(serviceDate)}
Patient: ${patientName}

To Whom It May Concern:

I am writing to discuss the charges for services received on ${formatDate(serviceDate)}. As a self-pay patient, I am requesting a fair rate based on publicly available pricing data.

Please contact me to discuss self-pay rates, financial assistance programs, or payment plan options.

Sincerely,

${patientName}

---
DISCLAIMER: This letter is informational only. Candid does not negotiate on your behalf and does not provide legal advice. You are responsible for reviewing, sending, and managing all communications with providers.`;
  },
};

export const LETTER_TEMPLATES: Record<DisputeLetterType, LetterTemplate> = {
  overcharge: overchargeTemplate,
  itemized_request: itemizedRequestTemplate,
  insurance_appeal: insuranceAppealTemplate,
  balance_billing: balanceBillingTemplate,
  duplicate_charge: duplicateChargeTemplate,
  negotiation: negotiationTemplate,
};
