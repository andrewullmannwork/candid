// Dispute letter templates — populated with facts from audit findings
// User reviews, edits, approves, and downloads. User sends letter themselves.

import type { AuditFinding, ParsedBill, DisputeLetterType } from "../billing/types";
import type { PlanContext, ProviderContact, AppealsAddress } from "./plan-context";
import type { DisputeEvidence, LineItemEvidence } from "./evidence-resolver";
import { groundFindingsForEvidence, OVERPAYMENT_BENCHMARK_SOURCE, type GroundFinding, type LineRecovery, type LetterRecoveryResult } from "./dispute-grounds";
import { DISPUTE_GROUND_CATALOG, type RequestBucket } from "./dispute-ground-catalog";

/**
 * The findings that license Medicare language in a letter (S305).
 *
 * DERIVED from the catalog's `benchmark` ground — the one ground defined as a
 * measurement against a public reference rate. `chargemaster` measures against
 * a provider's PUBLISHED charge and `zero_cost_share_overcharge` carries a
 * literal 0, so a benchmark number existing is not the same question.
 */
const MEDICARE_BENCHMARK_FINDING_TYPES: ReadonlySet<string> = new Set(
  DISPUTE_GROUND_CATALOG.benchmark.fromFindings,
);
import { buildObligationContext, renderObligationClauses } from "./obligation-render";
import { normalizeCoinsurancePct } from "@/lib/billing/coinsurance";
import { plainDate, easternDate } from "@/lib/format/dates";
import { RECIPIENT_DEPARTMENT_LINE } from "./letter-type";
import { adjudicationBand } from "@/lib/care/interface";

interface LetterTemplate {
  type: DisputeLetterType;
  /**
   * S295 — `evidence` is optional and additive: only insurance_appeal reads it
   * (its subject asserted a denial unconditionally, the same defect as its
   * opener). Every other template ignores the argument and is unchanged.
   */
  subject: (provider: string, evidence?: DisputeEvidence | null) => string;
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
  /**
   * Block C2 (item 4) — when true (dispute_letter_v3_design ON), the body renders
   * the conditional request-structure tree (type × payment-state asks + deadline +
   * claim/account reference) in place of the fixed boilerplate request list, and
   * reorders to detail → relief. Default false → the legacy letter renders
   * byte-identically. Threaded from the generators (the flag they already load).
   */
  v3DesignOn?: boolean;
  /**
   * §18 incr-3 (dispute_grounds_v1) — when true, the 3 provider templates
   * (overcharge / balance_billing / duplicate) source their finding-detail block +
   * total from the resolved EVIDENCE (groundFindingsForEvidence) instead of the
   * AuditReport `findings` param, which is nulled on the rerender path (the $0.00
   * bug). Default false → byte-identical (renders from `findings`). A SEPARATE flag
   * from v3DesignOn — NOT folded into the enforceDataTrustGate overload.
   */
  disputeGroundsOn?: boolean;
  /**
   * Block C2 (item 1) — the name the user adopted when attesting
   * (dispute.metadata.attestingAsName), defaulting to the account name. Flows into
   * String 2 (the attestation sentence) and the request block; falls back to
   * patientName when absent.
   */
  attestingName?: string;
  /**
   * S310 (Andrew) — the attested billing-office hold call's instant, when one
   * exists (same callLog entry the recital renders). buildRequestSection
   * upgrades the standing collections-hold ask to a written confirmation of
   * that call. Absent → the standing ask, byte-identical.
   */
  holdCallAt?: string | null;
  /**
   * §18 incr-4 (dispute_grounds_v1) — the per-line DEDUCTIBLE-AWARE recovery dollars
   * (resolveLetterRecovery, keyed by lineItemId). When present, buildRequestSection
   * sources the cost-share + balance-billing refund/write-off from here (== the card
   * recovery) instead of the deductible-BLIND `discrepancyAmount`, and OMITS the precise
   * dollar on non-assertable lines (§18.10.D). Undefined when the flag is OFF or no basis
   * was loaded → byte-identical legacy (discrepancyAmount) rendering.
   */
  letterRecovery?: Map<string, LineRecovery>;
  /** R3 step 5.3 — the full recovery result (set/claim tiers + clampBound) for the multi-charge
   *  asks + graceful degradation. Optional/additive → absent (OFF) means byte-identical. */
  recovery?: LetterRecoveryResult;
  /**
   * dispute_noplan_coverage_request_v1 — when ON, buildRequestSection reframes the
   * coverage ask (when no plan is on file to cite) and the insurer breakdown request.
   * Default false → byte-identical (asserting coverage copy + provider-shaped tail).
   */
  noPlanCoverageRequestOn?: boolean;
  /**
   * R3 step 5.4 Phase 3 (Item D — financial-assistance structure; INERT until activation). The
   * resolved per-dispute FA opt-in for a PROVIDER letter. When true, buildRequestSection adds an FA
   * application ask + folds an FA basis into the standing collections-hold. The activation
   * fast-follow composes it from the `financial_assistance_request_v1` flag + the
   * `dispute.metadata.finAssistOptIn` opt-in and threads it via the re-render path; no live
   * generator passes it today → defaults false → byte-identical. Provider-only.
   */
  finAssistContext?: boolean;
  /**
   * dispute-letters v2 S2 — escalation / collections inputs. User-supplied via dispute.metadata /
   * request body at launch (the FE collects them in S5/S6). Fail-closed: absent → the gated clause
   * is OMITTED via renderGated (never a placeholder).
   */
  /**
   * S300 (Item N) — the ONE prior-contact recital, pre-built by
   * `buildPriorContactRecital` and injected in this template's OPENING
   * (Andrew, Position B: a Final Notice's argument is "I tried, repeatedly,
   * and you didn't fix it", which has to precede the escalation, not trail
   * it). Every OTHER letter type receives the same block before the sign-off,
   * injected by the build paths. Replaces the client-supplied
   * `priorContactDates`, which cited one browser-passed date.
   */
  priorContactRecital?: string; // final_notice — opening recital of prior attempts (attested)
  certifiedMail?: boolean; // final_notice — user opted to send certified → adds the notation
  appealExhausted?: { attested: boolean; denialDate?: string | null }; // external_review gate
  collector?: { name: string; address?: string | null; originalCreditor?: string | null }; // debt_validation recipient (user-supplied)
  debtWithinWindow?: boolean; // debt_validation — within FDCPA §1692g 30-day window (route-computed)
}

/**
 * S295 — did an insurer actually adjudicate this claim?
 *
 * An insurer figure on a line (`insurancePaid` / `patientOwes`) is the proof
 * that the claim was processed at all, and equivalently that an EOB was parsed.
 * Absent any, we hold a provider bill and nothing else: there is no denial to
 * appeal and no Explanation of Benefits to have reviewed, so every sentence
 * that says otherwise is an unsupported assertion in a document the user mails
 * out — the same class the S294 letter-side grounding gate closed for dollars.
 *
 * TWO framings depend on it, which is why it is named for the signal rather
 * than for either consumer: insurance_appeal's denial framing (Re: header +
 * subject + opener + request section) and balance_billing's "after reviewing
 * my Explanation of Benefits" recital.
 *
 * Deliberately keyed on the EVIDENCE, not on `bill.billType`: a document typed
 * "eob" whose lines carry no insurer figures is a parse that recovered no
 * adjudication, and asserting a denial off that is exactly the failure this
 * guards. A denied line still passes — `insurancePaid: 0` is not null.
 *
 * ONE derivation, shared by every surface that frames a letter, so they cannot
 * drift apart.
 */
export function hasAdjudicationEvidence(evidence?: DisputeEvidence | null): boolean {
  return (evidence?.claims ?? []).some((c) =>
    (c.lineItemEvidence ?? []).some(
      (li) => li.insurancePaid != null || li.patientOwes != null,
    ),
  );
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
  const lines: string[] = [providerName, RECIPIENT_DEPARTMENT_LINE.provider];
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
  const lines: string[] = [insurerName, RECIPIENT_DEPARTMENT_LINE.insurer];
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

/** Recipient block for the collections debt-validation letter. The collector is USER-SUPPLIED
 *  (map §4 — collections is a user-supplied event at launch; no event model). */
function buildCollectorRecipientBlock(
  collector: { name: string; address?: string | null } | null | undefined,
): string {
  if (!collector?.name) return "";
  return [collector.name, collector.address ?? null].filter(Boolean).join("\n");
}

/** dispute-letters v2 S2 — fail-closed clause renderer. Returns "" when the gate value is missing
 *  (null / undefined / empty string / empty array), else the clause. Guarantees no `$[…]` / `[date]`
 *  placeholder ever renders. (S3 formalizes the CI no-placeholder fixture + retrofits the existing
 *  templates onto this helper.) */
export function renderGated<T>(value: T | null | undefined, clause: (v: T) => string): string {
  if (value == null) return "";
  if (typeof value === "string" && value.trim() === "") return "";
  if (Array.isArray(value) && value.length === 0) return "";
  return clause(value);
}

/* Guided Steps v1's attested-call recital (S297) MOVED to
 * `src/lib/disputes/prior-contact.ts` at S300 (tracker Item N). Its sentences
 * are carried there verbatim — the move consolidates WHO RENDERS the contact
 * history into one builder so a letter can never receive two contact blocks;
 * it does not rewrite the prose. See that module's header for the full rule. */

/** dispute-letters v2 S2 — state-specific citation registry. INERT at launch (no verified entries),
 *  so `resolveStateCitation` returns null for every (state, lever). Counsel-verified, per-entry
 *  activation is post-launch (map §10 / tracker Item R). */
const LEGAL_CITATION_REGISTRY: Record<string, string> = {}; // keyed `${state}:${lever}` — empty until verified

/** State-aware via profiles.state (planContext.userState); fail-closed to null (unverified state →
 *  federal levers + generic only, per map §5). */
function resolveStateCitation(state: string | null | undefined, lever: string): string | null {
  if (!state) return null;
  return LEGAL_CITATION_REGISTRY[`${state}:${lever}`] ?? null;
}

/** Patient + reference block. Surfaces Provider NPI when it's known —
 *  preferring planContext.providerContact, falling back to bill.provider.npi
 *  for audit-only flows. */
/**
 * S310 (Andrew) — the letter's SENDER block: the user's name + mailing address
 * above the dateline (standard business-letter position), so "send your
 * response to the address above" is finally truthful. Rendered at the TWO
 * compose exits (index.ts generateDisputeLetter + rerender.ts
 * rerenderDisputeLetter), never per-template; fail-soft — an absent or
 * incomplete address renders nothing and the letter is byte-identical.
 */
export function buildSenderBlock(
  name: string | null | undefined,
  addr:
    | { line1: string; line2: string | null; city: string; state: string; zip: string }
    | null
    | undefined,
): string | null {
  if (!addr) return null;
  const lines = [
    ...(name && name.trim() ? [name.trim()] : []),
    addr.line1,
    ...(addr.line2 ? [addr.line2] : []),
    `${addr.city}, ${addr.state} ${addr.zip}`,
  ];
  return lines.join("\n");
}

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
  // S295 — the Re: line is the first thing the recipient reads, and it asserted
  // an adverse benefit determination on every letter, including claims where no
  // adjudication appears in evidence at all. Same gate as the subject and the
  // opener (hasAdjudicationEvidence), so all three agree.
  const lines: string[] = [
    hasAdjudicationEvidence(params.evidence)
      ? "Re: Appeal of Adverse Benefit Determination"
      : "Re: Claim Processing Dispute — Request for Review",
    "",
  ];
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
  const isERISA = planContext?.planSource === "employer";

  // Case A — per-line cites carry the letter.
  if (hasExactPlan && anyBenefit) return "";

  // dispute-letters v2 S1 — ERISA citation gate (defense-in-depth on this DORMANT v3-OFF path; the
  // LIVE path is buildRequestSection under dispute_letter_v3_design=ON). Only self-reported employer
  // (ERISA) plans reach the §-cited branches below (§2560.503-1(g)/(h)(2)(iii), §1024(b)(4)); any
  // other/unknown source → a generic full-and-fair-review closing with no statute. Guarantees a
  // v3-design flip-OFF cannot mis-cite ERISA to a non-ERISA plan. Fail-safe (never over-fires).
  if (!isERISA) {
    return "I am entitled to a full and fair review of this denial. I request a written determination citing the specific plan provision on which any denial is based, together with copies of all documents relevant to this claim, including the applicable cost-sharing and coverage provisions.";
  }

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
// Block C2 item 4 — conditional request-structure tree
// ============================================================================
// A world-class demand letter's force is in what surrounds the evidence: a
// SPECIFIC, recipient-appropriate REQUEST (with the exact dollar relief), a
// DEADLINE tied to a real right, and a claim reference. This builder derives the
// relief from (dispute type × payment state × evidence availability), so the ask
// reads "refund the $X" / "write off the $Y" / "reverse the charge" instead of a
// generic "please review." Recipient voice differs: an insurer reprocesses /
// reverses / covers; a provider corrects the bill / refunds / writes off.
//
// v3-gated by the caller (flag OFF → the fixed legacy list renders, byte-
// identical). Statutory backbone = COMMERCIAL DEFAULT this session: the broadly-
// correct external-review hook (ACA §2719 / 45 CFR §147.136) + plain-English
// determination/itemized-statement asks. dispute-letters v2 S1 — plan_source is
// now threaded: the ERISA claim-file ask (§2560.503-1(h)(2)(iii)) is emitted for
// self-reported employer plans (isERISA) via the tail below. The §1024(b)(4)/
// §1132(c) document-penalty teeth remain deferred (separate administrator letter,
// post-launch tracker Q3). Guards:
// one ask per line (priority-bucketed); never demand reversal of correctly-
// applied cost-share (cost_share fires only on a computed overage); never name
// an amount we cannot compute; skip $0 lines; clamp amounts ≥ 0.

function joinClauses(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function capFirst(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export function buildRequestSection(params: {
  evidence: DisputeEvidence | null | undefined;
  planContext: PlanContext | null | undefined;
  recipient: "insurer" | "provider";
  letterRecovery?: Map<string, LineRecovery>;
  /** R3 step 5.3 — set/claim tiers + clampBound for the multi-charge asks + degradation. */
  recovery?: LetterRecoveryResult;
  noPlanCoverageRequestOn?: boolean;
  // dispute_grounds_v1 — the obligation-registry demand master-switch (R3 step 3). OFF → the
  // safe voice (fall_to_facts / omit) → byte-identical. Even ON, a demand fires only when a
  // predicate is met (all unknown today). Threaded from the render fns' disputeGroundsOn.
  demandsEnabled?: boolean;
  // R3 step 5.4 Phase 3 (Item D) — resolved provider FA opt-in. INERT until the activation
  // fast-follow wires the signal (the `financial_assistance_request_v1` flag + the
  // `dispute.metadata.finAssistOptIn` opt-in); defaults false → byte-identical. See
  // TemplateParams.finAssistContext.
  finAssistContext?: boolean;
  /** S310 (Andrew) — the attested billing-office hold call's instant, when one
   *  exists (the same callLog entry the recital renders). Upgrades the
   *  standing collections-hold ask to a written confirmation of that call. */
  holdCallAt?: string | null;
  /** S312 — the Phase 4-E trust gate, threaded so the fold's number agreement counts
   *  citations with the SAME trust test the evidence renders them with
   *  (providerPlanAskLine). Default false = RenderEvidenceOpts' own default. */
  gateUnverified?: boolean;
}): string {
  const { evidence, planContext, recipient, letterRecovery, recovery, noPlanCoverageRequestOn, demandsEnabled, finAssistContext, holdCallAt, gateUnverified } = params;
  if (!evidence) return "";
  const allLines = evidence.claims.flatMap((c) => c.lineItemEvidence);
  if (allLines.length === 0) return "";

  const isInsurer = recipient === "insurer";
  // dispute-letters v2 S1 — ERISA citation gate. Only self-reported employer (ERISA) plans get the
  // §2560.503-1(h)(2)(iii) claim-file ask below; any other/unknown source → the generic asks only
  // (full-and-fair-review default). Coarse + fail-safe: only the user's explicit "employer" choice
  // sets profiles.plan_source='employer', so this can under-fire but never over-fire.
  const isERISA = planContext?.planSource === "employer";
  const payee = isInsurer ? (planContext?.insurer?.name || "the plan") : "the provider";
  const label = (li: LineItemEvidence): string =>
    li.billingCode ? `${li.serviceName} (${li.billingCode.type} ${li.billingCode.value})` : li.serviceName;
  const sumOf = (arr: LineItemEvidence[], pick: (li: LineItemEvidence) => number | null | undefined): number =>
    arr.reduce((s, li) => s + Math.max(0, pick(li) ?? 0), 0);

  // R3 step 5.3 — multi-charge derivations from the full recovery (all no-ops when `recovery` is
  // absent → OFF byte-identical). `removedIds` drops a duplicate's removed copy from the reprice
  // buckets (removal dominates); `clampBound`/`lineIsClampBound` drive graceful degradation — a
  // clamp-bound claim's precise dollars drop from the asks so the demand stands alone (§18.10.D).
  const setRecoveries = recovery?.setRecoveries ?? [];
  const claimRecoveries = recovery?.claimRecoveries ?? [];
  const removedIds = new Set(setRecoveries.flatMap((s) => s.removedLineItemIds));
  const clampBound = new Set(recovery?.clampBoundClaimIds ?? []);
  const claimIdByLine = new Map<string, string>();
  const lineById = new Map<string, LineItemEvidence>();
  const dateByLine = new Map<string, string | null>();
  for (const c of evidence.claims) {
    for (const li of c.lineItemEvidence) {
      claimIdByLine.set(li.lineItemId, c.claimId);
      lineById.set(li.lineItemId, li);
      dateByLine.set(li.lineItemId, c.dateOfService);
    }
  }
  const lineIsClampBound = (li: LineItemEvidence): boolean => clampBound.has(claimIdByLine.get(li.lineItemId) ?? "");

  // §18 incr-4 — sum a deductible-aware recovery field over ONLY the assertable lines
  // (§18.10.D: a line whose precise dollar isn't backed contributes $0 → the remedy clause
  // drops and the demand stands alone). Used only when `letterRecovery` is present (flag ON).
  const sumAssertable = (
    arr: LineItemEvidence[],
    rec: Map<string, LineRecovery>,
    field: "refund" | "writeOff" | "capped",
  ): number =>
    arr.reduce((s, li) => {
      const r = rec.get(li.lineItemId);
      // R3 step 5.3 — a clamp-bound claim's precise dollar drops (graceful degradation).
      return r && r.assertable && !lineIsClampBound(li) ? s + r[field] : s;
    }, 0);

  // One ask per line, priority-bucketed (guard: no double-asks).
  const b: Record<RequestBucket, LineItemEvidence[]> = {
    attested: [], costShare: [], coverage: [], balanceBilling: [], coding: [],
  };
  for (const li of allLines) {
    // R3 step 5.3 — a removed duplicate copy is argued by the set tier (removal dominates); never
    // re-bucket it for a reprice/coverage ask (would double-count + argue "reprice" on a removed line).
    if (removedIds.has(li.lineItemId)) continue;
    // Skip lines with no money at stake (e.g. $0 quality-measure codes).
    if ((li.billedAmount || 0) === 0 && !li.patientOwes && !li.patientPaid) continue;
    if (li.serviceNotRenderedAttested) { b.attested.push(li); continue; }
    if (li.disputeType === "balance_billing") { b.balanceBilling.push(li); continue; }
    if (li.disputeType === "cost_share_misapplication" && (li.discrepancyAmount ?? 0) > 0) { b.costShare.push(li); continue; }
    if (li.disputeType === "coding_peer" && (li.peerCodes?.length ?? 0) >= 2) { b.coding.push(li); continue; }
    if (li.planBenefit || li.disputeType === "coverage_contradiction") { b.coverage.push(li); continue; }
    // No actionable standalone ground — leave to the fallback if everything is empty.
  }

  const asks: string[] = [];
  // Item A — set when the no-plan coverage hold (below) already requested a collections hold, so
  // the standing collections-hold doesn't render twice.
  let collectionsHoldRequested = false;
  // S310 (Andrew-approved fold) — when both the cost-share correction ask and
  // the coverage-track correction ask would render on a provider letter, they
  // fold into ONE sentence (the write-off clause carried along). These track
  // the cost-share ask so the coverage section can replace it in place.
  let costShareAskIndex: number | null = null;
  let costShareWriteOffClause = "";

  // 1) service_not_rendered (attested) — strongest; leads.
  if (b.attested.length > 0) {
    const names = joinClauses(b.attested.map(label));
    const many = b.attested.length > 1;
    const it = many ? "them" : "it";
    // R3 step 5.3 — drop precise dollars for clamp-bound claims (the ask still renders, sans amounts).
    const dollarLines = b.attested.filter((li) => !lineIsClampBound(li));
    const billed = sumOf(dollarLines, (li) => li.billedAmount);
    // S309 F12/C (Andrew) — refund/forgive dollars come from the SAME engine
    // recovery the cost-share ask adopted in §18 incr-4: ONE money basis for
    // the whole letter. This branch was the last raw reader — it quoted the
    // raw line's $500 while the recovery priced the header-consistent $300
    // (multi-charge L5). The billed figure stays the raw charge quote.
    // Absent map (flag OFF / legacy) → the raw sums, byte-identical.
    const refund = letterRecovery
      ? sumAssertable(b.attested, letterRecovery, "refund")
      : sumOf(dollarLines, (li) => li.patientPaid);
    const forgive = letterRecovery
      ? sumAssertable(b.attested, letterRecovery, "writeOff")
      : sumOf(dollarLines, (li) => li.patientOwes);
    const insPaid = isInsurer ? sumOf(dollarLines, (li) => li.insurancePaid) : 0;
    const clauses: string[] = [];
    if (isInsurer) {
      clauses.push(
        insPaid > 0
          ? `reverse the ${formatCurrency(insPaid)} paid for the ${many ? "services" : "service"} I have attested I did not receive (${names})`
          : `deny and reverse any payment for the ${many ? "services" : "service"} I have attested I did not receive (${names}${billed > 0 ? `, billed ${formatCurrency(billed)}` : ""})`,
      );
      if (refund > 0) clauses.push(`refund the ${formatCurrency(refund)} I paid`);
      if (forgive > 0) clauses.push(`ensure the ${formatCurrency(forgive)} billed to me is removed`);
      clauses.push(`confirm I bear no responsibility for ${it}`);
      clauses.push(`investigate and recoup any payment made for a service not rendered`);
      asks.push(`${capFirst(joinClauses(clauses))}. If you have documentation that the ${many ? "services were" : "service was"} provided to me, please send it.`);
    } else {
      clauses.push(
        forgive > 0
          ? `write off and remove the ${formatCurrency(forgive)} balance for the ${many ? "services" : "service"} I did not receive (${names})`
          : `remove the ${many ? "charges" : "charge"} for ${names}${billed > 0 ? ` (${formatCurrency(billed)})` : ""}, which I did not receive`,
      );
      if (refund > 0) clauses.push(`refund the ${formatCurrency(refund)} I paid`);
      clauses.push(`ensure ${many ? "they are" : "it is"} not referred to collections or reported to a credit bureau`);
      asks.push(`${capFirst(joinClauses(clauses))}. If you contend the ${many ? "services were" : "service was"} provided, please send documentation that ${many ? "they were" : "it was"} rendered to me.`);
    }
  }

  // 2) cost_share_misapplication — only with a real, computed overage.
  if (b.costShare.length > 0) {
    const many = b.costShare.length > 1;
    // §18 incr-4: source refund/write-off from the DEDUCTIBLE-AWARE per-line recovery
    // (== the card recovery) when available, counting only assertable lines (§18.10.D
    // omit). Legacy deductible-BLIND discrepancyAmount path when the map is absent (flag
    // OFF) → byte-identical.
    const refund = letterRecovery
      ? sumAssertable(b.costShare, letterRecovery, "refund")
      : b.costShare.reduce((s, li) => s + Math.min(li.discrepancyAmount ?? 0, li.patientPaid ?? 0), 0);
    const writeOff = letterRecovery
      ? sumAssertable(b.costShare, letterRecovery, "writeOff")
      : b.costShare.reduce((s, li) => {
          const over = li.discrepancyAmount ?? 0;
          return s + Math.max(0, over - Math.min(over, li.patientPaid ?? 0));
        }, 0);
    const verb = isInsurer
      ? `reprocess the affected ${many ? "charges" : "charge"} applying the cost-sharing my plan specifies (cited above)`
      : `correct my bill to the cost-sharing my plan specifies (cited above)`;
    const remedy: string[] = [];
    // S310 F18 (Andrew) — each letter claims only ITS party's money, mirroring
    // the panel rows: the cost-share refund is the INSURER letter's demand
    // (the fix is reprocessing), the write-off the provider/collector
    // letter's (the balance is theirs to stop billing). Same rule as
    // resolveLetterRecovery's recipient-scoped totals, so the sentence, the
    // headline amount, and the panel agree by construction.
    if (isInsurer && refund > 0) remedy.push(`refund the ${formatCurrency(refund)} I overpaid`);
    if (!isInsurer && writeOff > 0) remedy.push(`write off the ${formatCurrency(writeOff)} billed above my correct responsibility`);
    costShareAskIndex = asks.length;
    costShareWriteOffClause =
      !isInsurer && writeOff > 0
        ? `, and write off the ${formatCurrency(writeOff)} billed above my correct responsibility`
        : "";
    asks.push(`${capFirst(verb)}${remedy.length ? `, and ${joinClauses(remedy)}` : ""}.`);
  }

  // 3) coverage_contradiction (+ any covered line not otherwise asked).
  if (b.coverage.length > 0) {
    const many = b.coverage.length > 1;
    // dispute_noplan_coverage_request_v1 — when NO coverage line has a citable plan
    // (no planBenefit), do not assert coverage we can't back (Evidence Disclosure Rule).
    // Instead compel the insurer to justify the denial + produce the plan document +
    // line-by-line adjudication, and ask the provider to hold collections pending it.
    const noPlanToCite = !!noPlanCoverageRequestOn && !b.coverage.some((li) => li.planBenefit);
    if (isInsurer) {
      asks.push(
        noPlanToCite
          // S295 (Andrew-approved) — the §2560.503-1 entitlement attaches to the
          // CLAIM, so the sentence holds either way; saying "this denial" asserted
          // an adverse determination the evidence may not contain. Withdraw-only.
          ? `State, in writing, the specific plan provision and any clinical criteria on which this claim's processing rests, and produce the governing plan document — the Summary Plan Description or Evidence of Coverage — together with the line-by-line adjudication of the claim. I am entitled to a full and fair review of this claim; furnish these records so it can be reviewed against the plan's actual terms, and reprocess the claim if those terms require payment.`
          : `Cover ${many ? "these services" : "this service"} under the plan terms cited above, reprocess the claim, and pay the provider the plan-allowed ${many ? "amounts" : "amount"} so that I am not balance-billed; for any continued denial, issue a written determination identifying the specific plan provision relied upon.`,
      );
    } else {
      // Provider can't decide coverage — bill only per the EOB, or hold pending it.
      if (noPlanToCite) {
        asks.push(
          `Until my insurer issues its coverage determination, place any collection activity on this balance on hold and do not report it to a credit bureau. Once the insurer determines how the claim should have been processed, rebill me for only the patient cost-share its determination establishes.`,
        );
        collectionsHoldRequested = true; // dedup: the standing collections-hold (Item A) won't double up
      } else if (costShareAskIndex != null) {
        // S310 (Andrew-approved fold) — the two "correct my bill" asks were
        // near-duplicates when both fired; ONE sentence replaces the
        // cost-share ask in place, keeping its write-off clause.
        // S312 — number agreement from the CITED-line count: the SAME predicate the
        // provider bill view renders citations with (providerPlanAskLine), over the
        // fold's own buckets — so "(cited above)" refers to exactly the lines the
        // evidence cites, singular when there is one. A bare-planBenefit rider in
        // b.coverage (nothing wrong on the line) no longer pluralizes the sentence.
        const citedCount = [...b.costShare, ...b.coverage].filter((li) =>
          providerPlanAskLine(li, gateUnverified ?? false),
        ).length;
        asks[costShareAskIndex] =
          `Correct my bill to reflect only the cost-sharing my plan specifies for ${citedCount === 1 ? "this service" : "these services"} (cited above), as determined by my insurer${costShareWriteOffClause}.`;
      } else {
        asks.push(
          `Correct my bill to reflect only my cost-sharing under my plan's coverage of ${b.coverage.length > 1 ? "these services" : "this service"}, as determined by my insurer.`,
        );
      }
    }
  }

  // 4) balance_billing — limit to in-network (the core relief) + the obligation clauses (NSA,
  // contracted-rate) from the registry, voiced per recipient (R3 step 3). NSA stays fall_to_facts
  // (the verbatim "apply any applicable NSA" clause); contracted_rate_apply has no registry prose —
  // its copy is the DATA-AWARE Item B ask below. demandsEnabled OFF / no allowed-rate → byte-identical.
  if (b.balanceBilling.length > 0) {
    const many = b.balanceBilling.length > 1;
    // §18 incr-4: the deductible-aware write-off (== the card recovery) on assertable lines;
    // legacy deductible-blind discrepancyAmount when the map is absent. (Refund-of-a-paid
    // balance bill stays an incr-5 letter-co-review enrichment; this preserves the "write off"
    // copy.)
    const over = letterRecovery
      ? sumAssertable(b.balanceBilling, letterRecovery, "writeOff")
      : sumOf(b.balanceBilling, (li) => li.discrepancyAmount);
    const ctx = buildObligationContext(b.balanceBilling);
    const obClauses = renderObligationClauses("balance_billing", recipient, ctx, demandsEnabled ?? false);
    const obText = obClauses.length > 0 ? ` and ${obClauses.join(" and ")}` : "";

    // R3 step 5.4 Phase 3 (Item B) — contracted-rate ask. A SINGLE balance-billed line with a known
    // allowed amount below the billed charge cites the allowed amount. Network-aware (claims-lawyer
    // review, S254): in-network / tiered (ctx.contractExists — a proven participating contract) → the
    // strong contracted-rate demand, NSA omitted (it is an out-of-network protection); null / unknown
    // (rate known, contract not proven) → a factual allowed-amount request; out-of-network → suppress
    // (no contract to invoke → the base ask + NSA below is the right relief). Multi-line falls to the
    // aggregate base ask. Replaces the base ask for the line (no doubled "limit to cost-sharing");
    // demandsEnabled OFF or no allowed-rate → itemB null → base ask → byte-identical. Andrew-approved
    // copy (S254); plain-language per [[feedback_candid_copy_plain_language]].
    let itemB: string | null = null;
    if ((demandsEnabled ?? false) && b.balanceBilling.length === 1) {
      const li = b.balanceBilling[0];
      const allowed = li.allowedAmount;
      if (allowed != null && li.billedAmount > allowed && !lineIsClampBound(li)) {
        const svc = label(li);
        const aStr = formatCurrency(allowed);
        const bStr = formatCurrency(li.billedAmount);
        const overStr = formatCurrency(li.billedAmount - allowed);
        if (ctx.contractExists === true) {
          // in-network / tiered — proven contract → the contracted-rate demand.
          itemB = isInsurer
            ? `Your records show ${svc} was provided in-network at a contracted rate of ${aStr}. Please make sure my cost-share is based on that contracted rate — not the provider's billed ${bStr} — and that the provider writes off the ${overStr} difference, as your network agreement requires. If my claim was processed otherwise, please reprocess it and correct my cost-share.`
            : `My plan shows this provider as in-network. Their contract rate sets the price for ${svc} at ${aStr} — which the provider accepts as payment in full. The ${bStr} billed is ${overStr} above that price, and an in-network provider may not bill me the difference. Please reduce this charge to ${aStr} and bill me only my in-network cost-share.`;
        } else if (li.networkStatus !== "out_of_network") {
          // null / unknown network — factual allowed-amount request (no contract asserted).
          itemB = isInsurer
            ? `For ${svc}, my plan allowed ${aStr}. Please confirm my cost-share was calculated on the allowed amount rather than the provider's billed ${bStr}, and reprocess if it was not.`
            : `My plan's allowed amount for ${svc} is ${aStr}, not the billed ${bStr}. Please base my balance on my plan's allowed amount and cost-sharing, and itemize any portion of the ${overStr} difference you contend I owe.`;
        }
        // out_of_network → itemB stays null → base ask + NSA below (the correct OON relief).
      }
    }

    asks.push(
      itemB ??
        `Limit my responsibility for ${many ? "these services" : "this service"} to my in-network cost-sharing${obText}${over > 0 ? `; write off the ${formatCurrency(over)} billed above it` : ""}.`,
    );
  }

  // 5) coding_peer — AMA-compliant "verify whether" (never "should be coded as").
  if (b.coding.length > 0) {
    const peer = b.coding[0].peerCodes?.[0]?.code;
    if (peer) asks.push(`Verify whether code ${peer} more accurately reflects the service provided, and reprocess accordingly.`);
  }

  // 5b) chargemaster (Item C, R3 5.4 Phase 3) — lines billed ABOVE the provider's OWN published
  // chargemaster average. A `chargemaster` detector finding carries that published rate in
  // benchmarkAmount; this data-aware ask cites it (RAISE voice — "please review", never assert; §4).
  // Gated by published_rate_exceeded × demandsEnabled (via buildObligationContext) → byte-inert until
  // the dispute_grounds_v1 flip AND the hospital_hpt rate seed land. NPI-keyed match happens upstream
  // (the detector); here we just render. Provider → reduce toward published pricing; insurer → don't
  // pass it through. rung-2 (exact-list "remove the excess") + rung-3 (complaints) stay deferred.
  {
    const cmEntries = allLines
      .filter((li) => !removedIds.has(li.lineItemId) && !lineIsClampBound(li))
      .map((li) => {
        const f = (li.auditFindings ?? []).find(
          (x) => x.type === "chargemaster" && x.benchmarkAmount != null && li.billedAmount > (x.benchmarkAmount ?? 0),
        );
        return f && f.benchmarkAmount != null ? { li, avg: f.benchmarkAmount } : null;
      })
      .filter((e): e is { li: LineItemEvidence; avg: number } => e !== null);
    if (cmEntries.length > 0 && (demandsEnabled ?? false) && buildObligationContext(cmEntries.map((e) => e.li)).publishedRateExceeded === true) {
      for (const { li, avg } of cmEntries) {
        const svc = label(li);
        const over = li.billedAmount - avg;
        asks.push(
          isInsurer
            ? `For ${svc}, the provider billed ${formatCurrency(li.billedAmount)} — above the ${formatCurrency(avg)} average charge on its own chargemaster. Please confirm my cost-share is not based on a charge that exceeds the provider's published pricing.`
            : `Your hospital's own chargemaster lists an average charge of ${formatCurrency(avg)} for ${svc}, yet I was billed ${formatCurrency(li.billedAmount)} — ${formatCurrency(over)} more. Please review this charge and bring my bill in line with your own published pricing.`,
        );
      }
    }
  }

  // 6) SET tier (duplicate / unbundling). The removed copy was dropped from the buckets above (removal
  // dominates); here the set is argued ONCE. Provider letter → remove/refund the redundant charge
  // (patient-exposed; R3 step 5.3). Insurer letter (R3 step 5.4 Phase 2) → the counsel-blessed
  // burden-shift ask, $0 to the headline (1a holds coherence): DUPLICATE = substantiate → (if
  // unsubstantiated) correct accumulators → recoup; UNBUNDLING = determine/reprocess → produce the
  // corrected coding determination + revised EOB → adjust accumulators. A set whose service is also
  // attested not-rendered is skipped (1b — that whole-charge ask subsumes it). Provider precise dollars
  // drop for a clamp-bound claim (the ask stands without a number); the insurer asks carry no dollars.
  for (const set of setRecoveries) {
    // R3 step 5.4 (1b) — an attested member subsumes the set (the whole-charge not-rendered ask covers
    // it); read the SAME flag the fold uses so amount_disputed and this letter body can't drift (was an
    // inline members.some(serviceNotRenderedAttested) recompute — two sources could disagree).
    if (set.attestationSubsumed) continue;
    const members = set.memberLineItemIds.map((id) => lineById.get(id)).filter((l): l is LineItemEvidence => !!l);
    const ref = members[0];
    if (!ref) continue;
    const svc = label(ref);
    const dup = set.type === "duplicate";
    const d = dateByLine.get(ref.lineItemId);
    const dateStr = d ? formatDate(d) : null;
    if (!isInsurer) {
      // Provider letter — argue the patient-exposed dollars ONCE. UNCHANGED by Phase 2 (byte-identical).
      const bound = clampBound.has(set.claimId);
      if (set.recovery > 0) {
        const refund = bound ? 0 : set.refund;
        const writeOff = bound ? 0 : set.writeOff;
        const what = dup
          ? `the duplicate charge for ${svc}, which appears on my bill more than once`
          : `the unbundled charge for ${svc}, which should be billed under a single code`;
        const remedy: string[] = [];
        if (refund > 0) remedy.push(`refund the ${formatCurrency(refund)} I paid`);
        if (writeOff > 0) remedy.push(`write off the ${formatCurrency(writeOff)} still billed`);
        asks.push(`${capFirst(`remove ${what}`)}${remedy.length ? `, and ${joinClauses(remedy)}` : ""}.`);
      }
    } else if (dup) {
      // R3 step 5.4 Phase 2 — insurer DUPLICATE ask (counsel-blessed, verbatim). $0 to the headline:
      // a burden-shift — substantiate first, then correct accumulators, then recoup from the provider.
      asks.push(
        `${svc} appears more than once on this bill for the same service${dateStr ? ` and date of service, ${dateStr}` : ""}. This is a billing error. I ask that you: (1) require the provider to substantiate, with an itemized statement and documentation, that this service was actually rendered more than once; (2) if it cannot, correct my claim record so my deductible and out-of-pocket maximum reflect a single instance of this service; and (3) recover any resulting overpayment from the provider.`,
      );
    } else {
      // R3 step 5.4 Phase 2 — insurer UNBUNDLING ask (counsel-blessed, verbatim). $0 to the headline:
      // the insurer determines/reprocesses + PRODUCES the corrected coding determination + revised EOB.
      const codes = members.map((m) => (m.billingCode ? `${m.billingCode.type} ${m.billingCode.value}` : m.serviceName));
      asks.push(
        `This bill lists ${joinClauses(codes)} as separate charges${dateStr ? ` for ${dateStr}` : ""}. These appear to be components of a single service that should be billed under one comprehensive code; billing them separately — unbundling — inflates both the total charge and my share. Because your plan applies correct-coding edits (including the National Correct Coding Initiative) when it adjudicates claims, I ask that you: (1) determine whether these charges should be combined under a single comprehensive code and, if so, reprocess the claim on that basis; (2) provide your corrected coding determination and a revised Explanation of Benefits; and (3) adjust my deductible and out-of-pocket maximum to reflect the reprocessed amount.`,
      );
    }
  }

  // 7) R3 step 5.3 — CLAIM tier (unallocated balance): the bill total exceeds the sum of the listed
  // charges. Provider letter → itemize the gap. Precise dollar drops for a clamp-bound claim.
  if (!isInsurer && claimRecoveries.length > 0) {
    // S304 — the ask is composed from TWO independent facts, not one branch per
    // shape:
    //
    //   WHAT IS WRONG   the bill's own arithmetic doesn't close, OR the lines
    //                   don't itemise everything owed          → the statement
    //   WHAT TO ASK FOR already paid → refund; still owed → write-off
    //                                                          → the remedy
    //
    // They are genuinely orthogonal — an arithmetic gap on an unpaid bill wants
    // a write-off, an itemisation gap on a paid one wants a refund — so a
    // combined branch per pair would encode the bill shapes we happen to have
    // seen. Composed, a third finding route adds ONE statement, not two.
    //
    // The old single sentence ("the bill total exceeds the sum of the listed
    // charges") is FALSE on an arithmetic-gap bill: the identity path only fires
    // once the line charges have been proven to sum to the bill's own total, so
    // asserting otherwise hands the provider a one-line rebuttal.
    const live = claimRecoveries.filter((c) => !clampBound.has(c.claimId));
    const IDENTITY_SOURCE = "claim_header_identity";
    // S309 F17 — a THIRD basis: the user PAID above what the bill charged
    // (the derived overpayment tier). Exactly the extension the S304 composed
    // design anticipated: a new route adds ONE statement; the remedy line is
    // reused as-is (refund > 0 → "Refund the … difference or provide a
    // corrected statement …").
    const byBasis = [
      { kind: "identity" as const, group: live.filter((c) => c.benchmarkSource === IDENTITY_SOURCE) },
      { kind: "overpayment" as const, group: live.filter((c) => c.benchmarkSource === OVERPAYMENT_BENCHMARK_SOURCE) },
      { kind: "other" as const, group: live.filter((c) => c.benchmarkSource !== IDENTITY_SOURCE && c.benchmarkSource !== OVERPAYMENT_BENCHMARK_SOURCE) },
    ];
    for (const { kind, group } of byBasis) {
      if (group.length === 0) continue;
      const refund = group.reduce((sum, c) => sum + c.refund, 0);
      const writeOff = group.reduce((sum, c) => sum + c.writeOff, 0);
      const total = Math.round((refund + writeOff) * 100) / 100;
      if (total <= 0) continue;

      // Statement — rendered from components the audit rule emitted; no
      // subtraction happens here, so a reduction bucket added to the identity
      // later cannot go silently unmentioned.
      const gap = group.find((c) => c.arithmeticGap)?.arithmeticGap;
      const statement =
        kind === "identity" && gap
          ? `This bill's charges, adjustments and payments do not add up to the amount I was billed: the total charge of ${formatCurrency(gap.billed)} less ${gap.reductions.join(" and ")} leaves ${formatCurrency(gap.leftOver)}, but I was billed ${formatCurrency(gap.billedToPatient)}.`
          : kind === "overpayment"
            ? `My payments on this bill exceed the amount it charged me.`
            : `The bill total exceeds the sum of the listed charges.`;

      // Remedy — refund when the money is already out of pocket, forgiveness
      // when it is still charged. Mixed claims lead with the refund.
      const remedy =
        refund > 0
          ? `Refund the ${formatCurrency(total)} difference or provide a corrected statement showing how it was calculated.`
          : `Itemize the ${formatCurrency(total)} and confirm I owe only the itemized amounts.`;

      asks.push(`${statement} ${remedy}`);
    }
  }

  // Fallback — never emit an empty request block. (Substantive asks only; the housekeeping asks
  // below — FA application + collections-hold + the itemized/adjudication request — append after, so
  // a letter with only housekeeping still carries the fallback's substantive ask.)
  if (asks.length === 0) {
    asks.push(
      isInsurer
        ? `Review the charges identified above and issue a written determination identifying the specific plan provision relied upon for any denial.`
        : `Review the charges identified above and provide a corrected bill.`,
    );
  }

  // R3 step 5.4 Phase 3 (Item D — financial-assistance structure; INERT until activation). On a
  // PROVIDER letter where the patient has opted into financial assistance, ask the provider for its
  // FA options AND fold an FA basis into the standing collections-hold below. `finAssistContext` is
  // the resolved opt-in (the activation fast-follow composes it from the
  // `financial_assistance_request_v1` flag + `dispute.metadata.finAssistOptIn`); no live generator
  // passes it today → false → byte-identical. Coherence gate: at least one owed line that is NOT
  // attested not-rendered — you do not seek assistance for a balance you say you never incurred. This
  // SAME `faActive` drives both the ask and the hold clause, so the hold can never reference an FA
  // request the letter did not make. Patient-driven + provider-agnostic (charity care + for-profit
  // programs); asserts no statute (the §501(r) obligation-demand version is the deferred upgrade) →
  // counsel pass before the activation flip.
  const faActive =
    !isInsurer &&
    (finAssistContext ?? false) &&
    allLines.some((li) => (li.patientOwes ?? 0) > 0 && !li.serviceNotRenderedAttested);
  if (faActive) {
    asks.push(
      `I would like to apply for any financial assistance available for this balance. Please send me information on the options you offer.`,
    );
  }

  // R3 step 5.4 Phase 3 (Item A) — standing collections-hold. A provider letter asks to pause
  // collection activity + credit reporting on any outstanding balance (`patientOwes > 0`) while the
  // dispute is pending. Skipped when the no-plan coverage hold above already requested it (dedup via
  // collectionsHoldRequested). Unconditional (not demand-gated) → protects the patient the moment
  // the letter ships. Item D — when `faActive`, the ONE hold cites BOTH bases (dispute + FA review);
  // no redundant second hold. (When the no-plan hold pre-empted this one, collections are already
  // held by it and no false FA reference exists → FA-awareness stays scoped to this hold.)
  if (!isInsurer && !collectionsHoldRequested && allLines.some((li) => (li.patientOwes ?? 0) > 0)) {
    // S310 (Andrew-approved) — when the user already requested the hold by
    // phone (the attested billing-office call this letter also recites), the
    // ask upgrades to a written confirmation of THAT request; otherwise the
    // standing launch clause asks for the hold fresh.
    asks.push(
      holdCallAt
        ? `Please confirm in writing the hold I requested by phone on ${easternDate(holdCallAt)}.`
        : `I dispute these charges. While this dispute is unresolved${faActive ? " and my financial-assistance request is under review" : ""}, place any collection activity for this balance on hold and do not report it to a credit bureau. If it has already been reported, report it as disputed.`,
    );
  }

  // Tail — the supporting document each recipient owes (Item A). PROVIDER: always request a fully
  // itemized statement — the provider's charge detail, a distinct artifact from an insurer EOB, and we
  // have no signal for whether the patient already holds one, so always ask. INSURER: request the EOB /
  // line-by-line adjudication (its artifact) when we lack the per-line breakdown — never an "itemized
  // statement of charges" it does not hold (A1′ routing fix; replaces the prior flag-gated branch).
  const hasPerLineBreakdown = allLines.some((li) => li.insurancePaid != null && li.patientOwes != null);
  if (!isInsurer) {
    asks.push(
      `Provide a fully itemized statement for this account. For each charge, list the billing code (CPT, HCPCS, revenue code, or NDC), the date of service, the units or quantity, and the amount billed, so I can confirm the charges match the care I received.`,
    );
  } else if (!hasPerLineBreakdown) {
    asks.push(
      `Provide the claim's line-by-line adjudication — the explanation of benefits showing how each charge was processed, the amount allowed, and the reason for any denial.`,
    );
  }

  // dispute-letters v2 S1 — ERISA claim-file ask (insurer letters, employer-sponsored plans only).
  // The claims fiduciary owes the documents relevant to the claim, free of charge, under 29 CFR
  // §2560.503-1(h)(2)(iii); this also asks the plan to confirm the appeal-received date (§10 I1).
  // Non-employer/unknown → omitted (the generic EOB/adjudication ask above carries the document
  // request). §1024(b)(4) SPD-production is the deferred separate administrator letter (tracker Q3).
  if (isInsurer && isERISA) {
    asks.push(
      `As documents relevant to this claim under 29 CFR §2560.503-1(h)(2)(iii), please provide, free of charge, copies of the plan provisions, guidelines, and records relied upon in adjudicating it, and confirm in writing the date this appeal was received.`,
    );
  }

  // Assemble: numbered relief + deadline + recipient-appropriate consequence.
  // Deadline anchored to the §1024(b)(4) document-production window (30 days);
  // L1 will plan-type-tune (ERISA penalty / urgency-shortening).
  const numbered = asks.map((a, i) => `${i + 1}. ${a}`).join("\n");
  const state = planContext?.userState ?? null;
  const insurerRegulator = state ? `the ${state} Department of Insurance` : "the appropriate state insurance regulator";
  const providerForum = state ? `my state's consumer-protection authority (the ${state} Attorney General's office)` : "my state's consumer-protection authority";
  const consequence = isInsurer
    ? ` If this matter is not resolved, I intend to pursue external review under ACA §2719 / 45 CFR §147.136 and may file a complaint with ${insurerRegulator}.`
    : ` If this matter is not resolved, I may file a complaint with ${providerForum} and, where applicable, the federal No Surprises Help Desk.`;

  return [
    "RELIEF REQUESTED",
    "",
    `I request that ${payee}'s ${isInsurer ? "appeals department" : "compliance department"} respond in writing within 30 days of receipt and:`,
    "",
    numbered,
    "",
    `Please treat this as a formal ${isInsurer ? "appeal and request for review" : "billing dispute"}.${consequence}`,
  ].join("\n");
}

// ============================================================================
// Shared "Why this service should be covered" renderer
// ============================================================================
// Returns a formatted block (with trailing blank line) or "" when we don't have
// enough verified evidence to render anything useful. Internal provenance
// markers (source, confidence, k-anonymity counts) gate rendering but never
// appear in the output — see Candid_Data_Patterns.md hard rule 4.

/**
 * R3 step 5.4 (1c) — the trailing render flags collected into one options bag (was 3+ positional
 * booleans → a 4th would be a smell). `renderEvidenceBlock` forwards this verbatim to
 * `renderLineItemEvidence`; only the latter reads the fields. All optional with the SAME defaults the
 * positional params had → byte-identical. `disputeGroundsOn` gates the dismissed-finding skip.
 */
interface RenderEvidenceOpts {
  gateUnverified?: boolean;
  attestingName?: string;
  v3DesignOn?: boolean;
  disputeGroundsOn?: boolean;
  /**
   * S312 (Andrew's §0 ruling, 3rd raise) — "a PROVIDER letter argues from the bill's own
   * arithmetic; an INSURER letter argues from the plan's terms." When recipient === "provider"
   * AND disputeGroundsOn, the evidence section becomes the bill view: every line renders as a
   * charge line, plan citations render ONLY where a correction ask needs one
   * (providerPlanAskLine — the SAME predicate the fold's number agreement counts), the disputed
   * line leads with the bill's own charge, and the per-claim sums block renders from the SAME
   * recipient-scoped recovery fold the relief reads. Absent/insurer → byte-identical.
   */
  recipient?: "insurer" | "provider" | "collector";
  /** S312 — the fold result backing the sums block (the F17 overpayment row + clampBound).
   *  Same object buildRequestSection argues from — the sums can never disagree with the asks. */
  recovery?: LetterRecoveryResult;
}

/**
 * Phase 4 Task 4-E trust test, extracted (S312) so the evidence renderer and the fold's
 * number agreement read ONE definition. 3-case logic per Q-DR-4E-2 LOCK — see the call
 * site comment in renderLineItemEvidence.
 */
function planBenefitTrustedFor(li: LineItemEvidence, gateUnverified: boolean): boolean {
  return !!(
    li.planBenefit &&
    (!gateUnverified ||
      li.planBenefit.sbcExcerptVerified ||
      (li.planBenefit.covered === true &&
        (li.planBenefit.copay !== null || li.planBenefit.coinsurance !== null)))
  );
}

/**
 * S312 — the ONE "does this line's plan citation back a correction ask?" predicate.
 * On the provider bill view a line renders its plan-term content ONLY when this is true
 * (otherwise it is a plain charge line), and buildRequestSection's fold sentence counts
 * the SAME set for its "this service"/"these services" number agreement — one derivation,
 * so the citations the relief references are exactly the citations the evidence renders.
 * Mirrors buildRequestSection's ask buckets: a real cost-share discrepancy, a documented
 * coverage contradiction, or a balance-billing line. A bare planBenefit with nothing wrong
 * (the b.coverage rider) carries NO ask — its citation was the insurer-side noise Andrew's
 * §0 ruling removed. Attested lines lead with the attestation instead (existing rule).
 */
function providerPlanAskLine(li: LineItemEvidence, gateUnverified: boolean): boolean {
  if (li.serviceNotRenderedAttested) return false;
  if (!planBenefitTrustedFor(li, gateUnverified)) return false;
  return (
    (li.disputeType === "cost_share_misapplication" && (li.discrepancyAmount ?? 0) > 0) ||
    li.disputeType === "coverage_contradiction" ||
    li.disputeType === "balance_billing"
  );
}

function renderEvidenceBlock(
  evidence: DisputeEvidence | null | undefined,
  planContext: PlanContext | null | undefined,
  title: string = "Why this service should be covered",
  opts: RenderEvidenceOpts = {},
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
  //
  // S292 (#6 structural) — render the per-line clauses FIRST; the section header
  // (and each multi-claim sub-header) is emitted ONLY when at least one clause
  // rendered beneath it. Previously the title was pushed unconditionally before
  // the loop, so a claim whose every line gated out (renderLineItemEvidence
  // returns "" per line) produced a BARE header — "SUPPORTING DETAIL" followed
  // immediately by the next section (observed on dispute 01af62e8, claim
  // ecc74954). renderGated's fail-closed rule (map §5: missing value → omit the
  // whole clause) now extends to the section header itself: a header with zero
  // clauses is impossible by construction. CI: dispute-grounds/no-placeholder.ts.
  const bodyLines: string[] = [];
  let itemNumber = 1;
  // S312 — the provider bill view (see RenderEvidenceOpts.recipient). Gated on the SAME
  // flag as the grounds-sourced finding block so the OFF path stays byte-identical.
  const providerBillView = opts.recipient === "provider" && (opts.disputeGroundsOn ?? false);

  for (const claim of evidence.claims) {
    const claimBlocks: string[] = [];
    for (const li of claim.lineItemEvidence) {
      const block = renderLineItemEvidence(li, itemNumber, planContext, opts);
      if (block) {
        claimBlocks.push(block, "");
        itemNumber++;
      }
    }
    if (claimBlocks.length === 0) continue; // no clauses → no sub-header either
    if (multiClaim) {
      const header = [
        claim.providerName ?? "Bill",
        claim.dateOfService ? formatDate(claim.dateOfService) : null,
      ].filter(Boolean).join(" · ");
      bodyLines.push(header, "");
    }
    bodyLines.push(...claimBlocks);

    // S312 — the sums block ("what they add up to", Andrew's §0 ruling): the bill view
    // closes each claim's charge list with the bill's own arithmetic. Charged/payments are
    // the claim's effective totals — the SAME fields the fold's clamp pools read (paidCap /
    // respHeader), with the Z1.1d user-paid overlay already applied — and the Overpaid line
    // is the fold's own F17 overpayment row (recovery.claimRecoveries, clampBound-filtered
    // exactly as the relief filters it), so the sums can never disagree with the asks.
    // Fail-soft: no real totals (hand-built fixture evidence) → no block.
    if (providerBillView) {
      const charged = claim.effectiveTotals.patientResponsibility;
      const paid = claim.effectiveTotals.patientPaid;
      if (Number.isFinite(charged) && Number.isFinite(paid) && (charged > 0 || paid > 0)) {
        const clampBound = new Set(opts.recovery?.clampBoundClaimIds ?? []);
        const overpaidRow = (opts.recovery?.claimRecoveries ?? []).find(
          (c) =>
            c.claimId === claim.claimId &&
            c.benchmarkSource === OVERPAYMENT_BENCHMARK_SOURCE &&
            !clampBound.has(c.claimId),
        );
        bodyLines.push(
          `Charged to me on this bill: ${formatCurrency(charged)}`,
          `My payments toward this bill: ${formatCurrency(paid)}`,
        );
        if (overpaidRow) bodyLines.push(`Overpaid: ${formatCurrency(overpaidRow.refund)}`);
        bodyLines.push("");
      }
    }
  }

  // Zero rendered clauses across every claim → omit the whole section (header
  // included). Fail-closed: the letter reads as if the section doesn't exist.
  if (bodyLines.length === 0) return "";

  const lines: string[] = [title.toUpperCase(), "", ...bodyLines];

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
  opts: RenderEvidenceOpts = {},
): string {
  // R3 step 5.4 (1c) — defaults copied verbatim from the former positional params → byte-identical.
  const { gateUnverified = false, attestingName = "", v3DesignOn = false, disputeGroundsOn = false } = opts;
  // S312 — the provider bill view (Andrew's §0 ruling): plan-term content renders only
  // where a correction ask needs it; every line renders as a charge line regardless.
  // Same activation as renderEvidenceBlock's sums block (recipient=provider + grounds ON).
  const providerBillView = opts.recipient === "provider" && disputeGroundsOn;
  const planAskLine = providerBillView && providerPlanAskLine(li, gateUnverified);
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
    // Block C2 item 4 — in v3 the billed amount is always shown per line. It is
    // the charge from the bill itself (always reliable); perLineCitable only
    // governs the EOB split, not the billed figure. OFF → unchanged (byte-identical).
    li.billedAmount > 0 && (perLineCitable || v3DesignOn)
      ? `— billed ${formatCurrency(li.billedAmount)}`
      : null,
  ].filter(Boolean).join(" ");

  const bullets: string[] = [];

  // Block C2 (item 1, §1f L2) — lead with the user's service-not-rendered
  // attestation in the LOCKED copy (String 2): first-person, neutral, under the
  // name the user adopted when attesting. The attestation IS the spine — never
  // coached, never inflated to a cite-grade quote. Item 3: an attested line LEADS
  // with this; the plan cost-share citation is suppressed below (secondary).
  if (li.serviceNotRenderedAttested) {
    const svcLabel = codeLabel ? `${li.serviceName} (${codeLabel})` : li.serviceName;
    const attestPrefix = attestingName ? `I, ${attestingName}, attest` : "I attest";
    bullets.push(
      `   - ${attestPrefix}, based on my own records and recollection, that I did not receive the following service billed on this claim: ${svcLabel}.`,
    );
  }

  // Phase 4 Task 4-E: planBenefit-derived bullets are gated by trust level
  // when gateUnverified is true. 3-case logic per Q-DR-4E-2 LOCK:
  //   - Case 1 (cite-grade verified): bullet + verbatim blockquote
  //   - Case 2 (covered + structured cost-sharing populated, no cite-grade): bullet WITHOUT blockquote
  //   - Case 3 (no cite-grade AND no certainty of coverage): drop the planBenefit bullets entirely
  //   - Discrepancy bullet (derived from planBenefit math) gated on the same trust level
  // When gateUnverified === false (legacy / flag OFF), all bullets render unconditionally.
  const planBenefitTrusted = planBenefitTrustedFor(li, gateUnverified);

  // Block C2 item 3 — on an attested (service-not-rendered) line the plan
  // cost-share citation is SECONDARY: suppress it here so the attestation leads.
  // It returns only as an explicit "in the alternative" fallback below.
  // S312 — provider bill view: the citation renders ONLY where a correction ask
  // needs it (providerPlanAskLine); a line with nothing wrong is a plain charge
  // line (Andrew's §0: plan citations on no-ask lines were insurer-side logic
  // on a provider envelope). Insurer letters: unchanged (providerBillView false).
  if (li.planBenefit && planBenefitTrusted && !li.serviceNotRenderedAttested && (!providerBillView || planAskLine)) {
    // S109 PR #2 (Chunk A) — bullet prefix varies by sourcedFrom per the
    // lawyer-pass decision tree §3a, so the letter discloses honestly which
    // plan data backs the citation (user's exact-year plan vs current-plan-
    // as-proxy vs community-verified canonical archive). Pattern 1 #2 is
    // preserved — we never cite a year we don't have as if it's that year.
    // S295 — the $0 / preventive case. A zero copay rendered literally as
    // "specifies a $0.00 copay for this service", which reads as a machine
    // artifact in a document that gets mailed to an insurer. Zero cost-sharing
    // gets its own phrasing; every non-zero value stays byte-identical.
    const zeroCopay = li.planBenefit.copay === 0;
    const costDescriptor = li.planBenefit.copay != null
      ? `a ${formatCurrency(li.planBenefit.copay)} copay`
      : li.planBenefit.coinsurance != null
      ? li.planBenefit.coinsurance === 0
        ? "no coinsurance"
        : `${normalizeCoinsurancePct(li.planBenefit.coinsurance)}% coinsurance`
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
        prefix = zeroCopay
          ? `Per ${insurer} ${planName} ${yearClause}, this service is covered at no cost to me`
          : `Per ${insurer} ${planName} ${yearClause}, this service is covered with ${costDescriptor}`;
        break;
      }
      case "user_fallback": {
        const yearClause = li.planBenefit.sourcedFromYear != null
          ? `My current plan (${li.planBenefit.sourcedFromYear})`
          : "My current plan";
        prefix = zeroCopay
          ? `${yearClause} covers this service with no copay`
          : `${yearClause} specifies ${costDescriptor} for this service`;
        break;
      }
      case "user_exact":
      default: {
        const planName = planContext?.plan?.planName ?? "Your plan";
        const year = planContext?.plan?.planYear ? `, ${planContext.plan.planYear}` : "";
        prefix = zeroCopay
          ? `${planName}${year} covers this service with no copay`
          : `${planName}${year} specifies ${costDescriptor} for this service`;
        break;
      }
    }
    // S293 (#6) — the Source suffix is fail-closed (map §5): a benefit adopted
    // from a user-confirmed match (buildSecondaryPlanBenefit /
    // buildExactMatchPlanBenefit) carries citation:"" — rendering "Source: ."
    // would be a dangling fragment in a mailed letter. Omit the suffix entirely
    // when there is no citation string; the bullet's plan statement stands alone.
    // Verbatim plan excerpt (Case 1 only): render only when cite-grade verified
    // OR gating is off entirely (legacy behavior). Plain-text "Plan language:"
    // label — NOT Markdown. The letter body renders as plain text everywhere it
    // matters (whitespace-pre-wrap on-page + downloaded .txt + the copy the user
    // mails to the insurer); the prior `> *"..."*` Markdown rendered as literal
    // noise in all three. The quoted excerpt itself stays verbatim — CF-60 inv1:
    // do NOT alter the text inside the quotes.
    // S297 (Andrew E2E) — contradiction guard, TRUNCATE not omit (Andrew: the
    // quote is evidence; it just must not carry the words "Not covered").
    // Real case: the SBC parser stores the WHOLE table row as the excerpt
    // ("Teladoc Health consultation $0 Not covered" — "$0" is in-network,
    // "Not covered" is the OON column), so a covered-service bullet would
    // quote self-defeating words at the insurer. We keep the verbatim PREFIX
    // and mark the cut with an ellipsis — an honest partial quotation (CF-60
    // inv1: never alter quoted words; truncation-with-ellipsis alters none).
    // Degenerate case (negation leads the excerpt → nothing quotable) falls
    // back to omitting the line. Universal negation patterns; parser-side
    // excerpt hygiene tracked separately (S297 cross-workstream note).
    // (S312 — computed BEFORE the bullet push so the provider bill view can
    // fold the excerpt into the fused lead bullet; gating logic unchanged.)
    let quotableExcerpt = li.planBenefit.sbcExcerpt?.trim() ?? "";
    if (li.planBenefit.covered === true && quotableExcerpt) {
      const negation = /\bnot\s+covered\b|\bno\s+coverage\b|\bexcluded\b|\bexclusion\b/i.exec(
        quotableExcerpt,
      );
      if (negation) {
        const prefix = quotableExcerpt.slice(0, negation.index).replace(/[\s.·|,;:—–-]+$/, "");
        quotableExcerpt = prefix.length >= 8 ? `${prefix} …` : "";
      }
    }
    const excerptRenderable = !!quotableExcerpt && (!gateUnverified || li.planBenefit.sbcExcerptVerified);

    // S312 — the disputed-line lead (§1 approved bytes): where the old "Expected patient
    // cost per plan / Actual patient responsibility / Discrepancy" bullet fired on a
    // provider letter, the line now LEADS with the bill's own charge and folds the plan
    // basis + Source + Plan language into ONE bullet. The "Discrepancy: $X" sentence —
    // the insurer's reprocessing money on a provider envelope — is gone; the letter's own
    // relief already claims the right money (F18's recipient-scoped fold).
    const fusedLead =
      providerBillView &&
      li.expectedPatientCost != null &&
      li.actualPatientCost != null &&
      (li.discrepancyAmount ?? 0) > 0;
    if (fusedLead) {
      // user_exact (the sourcedFrom switch's default) takes §1's approved sentence; the
      // two proxy families keep their existing disclosure sentences verbatim (Pattern 1
      // #2 — never cite a year we don't have as if it's that year), the lead prepended.
      const planBasis =
        li.planBenefit.sourcedFrom === "canonical_archive" || li.planBenefit.sourcedFrom === "user_fallback"
          ? prefix
          : zeroCopay
            ? "My plan covers it with no copay, as determined by my insurer"
            : `My plan specifies ${costDescriptor} for it, as determined by my insurer`;
      bullets.push(
        `   - This bill charges me ${formatCurrency(li.actualPatientCost!)} for this service. ${planBasis}.${li.planBenefit.citation ? ` Source: ${li.planBenefit.citation}.` : ""}${excerptRenderable ? ` Plan language: "${quotableExcerpt}"` : ""}`,
      );
    } else {
      bullets.push(
        `   - ${prefix}.${li.planBenefit.citation ? ` Source: ${li.planBenefit.citation}.` : ""}`,
      );
      if (excerptRenderable) {
        bullets.push(`     Plan language: "${quotableExcerpt}"`);
      }
    }
  }

  if (li.insurancePaid != null || li.patientOwes != null) {
    // S140 — skip null fields instead of citing as $0 (cite-grade violation).
    // When parser populates only one of (insurance_paid, patient_owes), cite
    // only what we actually have. billedAmount always present.
    //
    // dispute-letters v2 S3 — fallback-first EOB arithmetic (map §5). A real EOB
    // reconciles by construction: allowed = insurer-paid + patient-owes, and
    // billed ≥ allowed, so insurer-paid + patient-owes ≤ billed. If our EXTRACTED
    // figures violate that (sum exceeds billed, or any negative), the fault is
    // almost certainly our parse — insurer systems don't emit non-reconciling
    // numbers — so OMIT the figures rather than hand over broken math (the
    // coverage / balance-billing asks still argue the line). $0.01 rounding
    // tolerance; partial data (a single field present) is unaffected.
    const eobReconciles =
      (li.billedAmount ?? 0) >= 0 &&
      (li.insurancePaid ?? 0) >= 0 &&
      (li.patientOwes ?? 0) >= 0 &&
      (li.insurancePaid ?? 0) + (li.patientOwes ?? 0) <= (li.billedAmount ?? 0) + 0.01;
    if (eobReconciles) {
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
  }

  if (li.expectedPatientCost != null && li.actualPatientCost != null && planBenefitTrusted && !li.serviceNotRenderedAttested) {
    const overage = li.discrepancyAmount ?? 0;
    // S312 — provider bill view: this bullet's job is done by the fused lead above (ask
    // lines) or deliberately absent (plain charge lines). "Expected/Actual/Discrepancy"
    // was the insurer's arithmetic on a provider envelope. Insurer letters: unchanged.
    if (overage > 0 && !providerBillView) {
      bullets.push(
        `   - Expected patient cost per plan: ${formatCurrency(li.expectedPatientCost)}. Actual patient responsibility: ${formatCurrency(li.actualPatientCost)}. Discrepancy: ${formatCurrency(overage)}.`,
      );
    }
  } else if (li.discrepancyReason && planBenefitTrusted && !li.serviceNotRenderedAttested) {
    // S312 — provider bill view: the reason explains a plan-term problem, so it renders
    // only beside a citation that backs an ask (plain charge lines carry no plan prose).
    if (!providerBillView || planAskLine) bullets.push(`   - ${li.discrepancyReason}`);
  } else if (!li.planBenefit && li.patientOwes != null && li.patientOwes > 0 && !li.serviceNotRenderedAttested) {
    // No plan match — at minimum explain the request crisply.
    bullets.push(
      `   - I request the plan determine the allowed amount for this code and apply the applicable cost-sharing; any amount above my in-network cost-sharing should be written off per plan terms.`,
    );
  }

  // Block C2 item 3 — attested line: cost-share is SECONDARY. The plan citation
  // and the discrepancy ask above were suppressed. If a real overage exists,
  // reintroduce it ONCE here as an explicit, de-weighted fallback — never the lead.
  if (
    li.serviceNotRenderedAttested &&
    li.planBenefit &&
    planBenefitTrusted &&
    li.expectedPatientCost != null &&
    li.actualPatientCost != null &&
    (li.discrepancyAmount ?? 0) > 0
  ) {
    bullets.push(
      `   - In the alternative, even had this service been provided, the plan's cost-sharing terms appear to have been misapplied: my responsibility would be ${formatCurrency(li.expectedPatientCost)}, not ${formatCurrency(li.actualPatientCost)}.`,
    );
  }

  // Community outcome bullet — "other claims that have been paid" signal.
  // Already k-anonymity-gated in the resolver (omitted when total_claims < 5).
  if (li.communityOutcome) {
    const c = li.communityOutcome;
    // BANDED, never counted (S305). This printed "3 of 5 claims for this code on
    // this plan have been paid" — to the insurer whose own members those claims
    // belong to. The average payment is an aggregate statistic rather than a
    // cell count, so it stays; the band replaces the arithmetic.
    const band = adjudicationBand(c.paidCount, c.totalClaims);
    if (band) {
      const avg =
        c.avgPaidAmount != null ? `; average payment ${formatCurrency(c.avgPaidAmount)}` : "";
      bullets.push(
        `   - This code is ${band} on this plan${avg} (anonymized, aggregated Candid member data).`,
      );
    }
  }

  // Sibling-code bullet — "similar procedures but with slightly different
  // billing codes that have been paid." Already filtered to paid siblings.
  if (li.siblingCodes && li.siblingCodes.length > 0) {
    const sibParts = li.siblingCodes
      .slice(0, 3)
      // Labels only — "(4/6 paid)" was a small cell beside a named code. The
      // argument is that adjacent codes ARE paid on this plan; the tally adds
      // nothing to it and discloses what the band exists to withhold.
      .map((s) => `${s.label}${s.avgPaidAmount != null ? ` (average payment ${formatCurrency(s.avgPaidAmount)})` : ""}`)
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
        `   - Community benchmark: median billed rate for this code${regionSuffix} is ${formatCurrency(median)}, from anonymized Candid member reports. The ${formatCurrency(li.billedAmount)} charged is ${Math.round(overageRatio * 100)}% above that median.${communityPaidSuffix}`,
      );
    } else if (overageRatio > -0.1) {
      bullets.push(
        `   - Community benchmark: median billed rate for this code${regionSuffix} is ${formatCurrency(median)}, from anonymized Candid member reports — roughly in line with the billed amount.${communityPaidSuffix}`,
      );
    }
  }

  // Audit findings bullet — Medicare benchmark comparison + overcharge /
  // duplicate / upcoding flags captured at claim creation.
  if (li.auditFindings && li.auditFindings.length > 0) {
    for (const f of li.auditFindings) {
      // R3 step 5.4 (1c) — when dispute_grounds_v1 is ON, skip findings the user dismissed ("not an
      // issue"), matching the recovery math (which only runs ON + already skips dismissed). OFF →
      // renders all (byte-identical). Activates atomically with the flag.
      if (disputeGroundsOn && f.dismissed) continue;
      const parts: string[] = [];
      parts.push(`Candid audit flag (${f.title})`);
      if (f.benchmarkAmount != null && f.benchmarkSource) {
        parts.push(`${f.benchmarkSource} benchmark ${formatCurrency(f.benchmarkAmount)}`);
      }
      if (f.estimatedOvercharge > 0) {
        const amountLabel =
          f.type === "duplicate" ? "duplicate amount"
          : f.type === "balance_billing" ? "amount above allowed"
          : f.benchmarkAmount != null ? "amount above benchmark"
          : "amount in question";
        parts.push(`${amountLabel} ${formatCurrency(f.estimatedOvercharge)}`);
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

  // S312 — provider bill view: a line with no rendered clauses is still a CHARGE on the
  // bill. The section is the bill's own charge list ("THIS BILL'S CHARGES AND MY
  // PAYMENTS"), so the headline renders alone — the §1 "plain charge line". Every other
  // track keeps the fail-closed omission (a bare line would be noise under an argument
  // header like "Supporting detail").
  if (providerBillView) return [headline, ...bullets].join("\n");
  return bullets.length > 0 ? [headline, ...bullets].join("\n") : "";
}

export function formatDate(iso: string): string {
  // S109 PR #2 (Chunk A fix) — DATE-ONLY values render UTC-pinned so ISO dates
  // like "2023-04-25" never shift a day. S309 F13: centralized in
  // src/lib/format/dates.ts; INSTANTS (datelines, call/sent timestamps) go
  // through `easternDate` instead — Andrew's one-clock ruling.
  return plainDate(iso);
}

function formatCurrency(amount: number): string {
  // S304 — thousands separators. Letters quote four-figure charges routinely
  // ("$1,404.00" reads; "$1404.00" is a typo waiting to be argued with), and
  // ONE formatter keeps every figure in a letter consistent rather than the
  // arithmetic sentence carrying commas its neighbours lack. Identical output
  // below $1,000, so existing copy is unchanged.
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
    v3DesignOn,
    disputeGroundsOn,
    attestingName,
    letterRecovery,
    holdCallAt,
    recovery,
    noPlanCoverageRequestOn,
    finAssistContext,
  }) => {
    // §18 incr-3 — source the finding block from EVIDENCE when the flag is ON (rerender-safe;
    // kills the $0.00 bug). OFF or no-evidence → the AuditReport findings (byte-identical;
    // f.description ?? "" is a no-op there — AuditFinding.description is a required string).
    const effectiveFindings: Array<AuditFinding | GroundFinding> =
      disputeGroundsOn && evidence ? groundFindingsForEvidence(evidence) : findings;
    // S305 — the letter may only claim a Medicare comparison it actually made.
    //
    // The opening clause asserts the charges were "compared to publicly
    // available Medicare payment data" and the closing line quotes a total
    // "above the Medicare benchmark". Both were UNCONDITIONAL, so a provider
    // letter whose grounds are not benchmark-based said so anyway — and on a
    // claim whose only ground is CLAIM-scoped (`unallocated_balance`, whose
    // dollars are a deliberately disjoint pool and never reach the per-line
    // ground findings) it announced discrepancies, listed NONE, and quoted
    // $0.00 as the amount in dispute, three paragraphs above a $33.85 demand.
    //
    // Licensed by the benchmark's SOURCE, not by a benchmark number existing:
    // chargemaster measures against a provider's published charge and
    // zero-cost-share carries a literal 0. Same fail-closed rule
    // `renderEvidenceBlock` applies — an unsupported clause is omitted, never
    // softened, because asserting what the evidence doesn't carry hands the
    // provider a one-line rebuttal (the S304 lesson on the claim-tier sentence).
    // Which findings license it comes from the CATALOG, not a literal here: the
    // `benchmark` ground is defined as the public-reference-rate ground
    // (§18.10.A, "public reference rate (Medicare), no obligated party"), and
    // its `fromFindings` is the list. A second reference-rate finding added
    // there brings the letter with it; a list retyped here would not.
    //
    // ⚠ NOT the benchmarkSource string. That was the first cut and it is
    // brittle free text — today's rule writes "CMS PPL" while legacy rows and
    // the golden corpus say "Medicare", so an exact match silently stripped the
    // paragraph from letters that had genuinely earned it (caught by the golden
    // corpus, not by reasoning).
    const isMedicareBenchmarked = (f: AuditFinding | GroundFinding) =>
      MEDICARE_BENCHMARK_FINDING_TYPES.has(f.type) && f.benchmarkAmount != null;
    const medicareFindings = effectiveFindings.filter(isMedicareBenchmarked);
    const comparedToMedicare = medicareFindings.length > 0;

    const findingDetails = effectiveFindings
      .map(
        (f, i) =>
          `${i + 1}. ${f.title}\n   Billed amount: ${formatCurrency(f.billedAmount)}${isMedicareBenchmarked(f) ? `\n   Medicare national average: ${formatCurrency(f.benchmarkAmount!)}\n   Amount above the Medicare benchmark: ${formatCurrency(f.estimatedOvercharge)}` : ""}\n   ${f.description ?? ""}`
      )
      .join("\n\n");

    // Sums the BENCHMARKED findings only — the old total swept in duplicate and
    // balance-billing dollars and called them a Medicare overage.
    const totalOvercharge = medicareFindings.reduce(
      (sum, f) => sum + f.estimatedOvercharge,
      0
    );

    // S312 (Andrew's §0 ruling) — under the grounds flag the provider evidence section IS
    // the bill's own arithmetic: the header names it, every line renders as a charge line,
    // and the sums block closes it. OFF → the legacy header + rendering, byte-identical.
    const evidenceBlock = renderEvidenceBlock(
      evidence,
      planContext,
      (disputeGroundsOn ?? false) ? "This bill's charges and my payments" : "Supporting evidence for each charge",
      { gateUnverified: gateUnverified ?? false, attestingName: attestingName ?? patientName, v3DesignOn: v3DesignOn ?? false, disputeGroundsOn: disputeGroundsOn ?? false, recipient: "provider", recovery },
    );

    const recipientBlock = buildProviderRecipientBlock(providerName, planContext?.providerContact, bill);
    const patientRefBlock = buildPatientReferenceBlock(patientName, undefined, planContext?.providerContact, bill);

    // Block C2 item 4 — v3 replaces the fixed "I am requesting 1/2/3" list with
    // the conditional request tree (provider voice). OFF → byte-identical.
    const requestBlock = (v3DesignOn ?? false)
      ? buildRequestSection({ evidence, planContext, recipient: "provider", letterRecovery, recovery, noPlanCoverageRequestOn, finAssistContext, demandsEnabled: disputeGroundsOn ?? false, holdCallAt, gateUnverified: gateUnverified ?? false })
      : `I am requesting the following:

1. A detailed, itemized bill showing all charges, procedure codes (CPT/HCPCS), and quantities.
2. A review and explanation of the charges identified above.
3. An appropriate adjustment to my account if these charges are found to be in error.

Under the No Surprises Act and applicable state consumer protection laws, I am entitled to a clear and accurate bill. I request a written response within 30 days of receipt of this letter.`;

    return `${easternDate(new Date())}

${recipientBlock}

Re: Billing Dispute — Date of Service: ${formatDate(serviceDate)}
${patientRefBlock}${renderGated(accountNumber, (a) => `\nAccount #: ${a}`)}

To Whom It May Concern:

I am writing to formally dispute charges on my medical bill for services rendered on ${formatDate(serviceDate)}. ${
      comparedToMedicare
        ? `After reviewing my bill and comparing the charges to publicly available Medicare payment data and standard billing practices, I have identified the following potential discrepancies:`
        : `After reviewing this bill against my plan's coverage and the bill's own figures, I have identified the problems described below.`
    }
${findingDetails ? `\n${findingDetails}\n` : ""}${
      comparedToMedicare
        ? `\nThe total amount billed above the Medicare benchmark across these items is ${formatCurrency(totalOvercharge)}.\n`
        : ""
    }${evidenceBlock ? `\n${evidenceBlock}` : ""}
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
${requestBlock}

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
    return `${easternDate(new Date())}

${recipientBlock}

Re: Request for Itemized Bill — Date of Service: ${formatDate(serviceDate)}
${patientRefBlock}${renderGated(accountNumber, (a) => `\nAccount #: ${a}`)}

To Whom It May Concern:

I am writing to request a complete itemized bill for services rendered on ${formatDate(serviceDate)}. Please provide a detailed, line-by-line breakdown of all charges so I can verify them against the care I received.

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
  // S295 — matches the body's opener: an appeal OF A DENIAL only when a denial
  // is in evidence; otherwise this is a claim-processing dispute and the
  // subject line has to say so (the recipient reads it first).
  subject: (provider, evidence) =>
    hasAdjudicationEvidence(evidence)
      ? `Appeal of Claim Denial — ${provider}`
      : `Claim Processing Dispute — Request for Review — ${provider}`,
  body: ({
    patientName,
    providerName,
    serviceDate,
    accountNumber,
    bill,
    planContext,
    evidence,
    gateUnverified,
    v3DesignOn,
    disputeGroundsOn,
    attestingName,
    letterRecovery,
    recovery,
    noPlanCoverageRequestOn,
  }) => {
    // S111 smoke #3/#4 — insurer precedence:
    //   1. planContext.insurer (resolved in plan-context.ts preferring
    //      boundCanonicalPlan.insurerName when bound — iteration 3 fix)
    //   2. planContext.boundCanonicalPlan.insurerName (defensive fallback
    //      in case resolveInsurer returned null but the bind succeeded)
    //   3. bill.insurer.name (from EOB metadata)
    //   4. planContext.plan.insurerName (user's plan row)
    //   5. generic addressee (dispute-letters v2 S3 — never a bracketed placeholder;
    //      enforced by the no-placeholder fixture)
    const insurerName = planContext?.insurer?.name
      || planContext?.boundCanonicalPlan?.insurerName
      || bill.insurer?.name
      || planContext?.plan?.insurerName
      || "the plan administrator";
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
      (v3DesignOn ?? false) ? "Supporting detail" : "Why this service should be covered",
      { gateUnverified: gateUnverified ?? false, attestingName: attestingName ?? patientName, v3DesignOn: v3DesignOn ?? false, disputeGroundsOn: disputeGroundsOn ?? false },
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

    // Block C2 item 4 — v3 reorders to detail → relief: the top boilerplate
    // "full review 1/2/3" list becomes a one-line pointer, and the ERISA closing
    // + escalation paragraphs are replaced by the conditional request tree (which
    // carries its own deadline + §2719 consequence). OFF → byte-identical.
    // S295 — the denial-framing gate. The opener asserted a denial
    // UNCONDITIONALLY, including on a bill with no EOB behind it. See
    // `hasAdjudicationEvidence` for why the signal is the insurer figures.
    // Withdraw-only: with denial evidence present the sentence is unchanged.
    const denialEvidencePresent = hasAdjudicationEvidence(evidence);
    const openingSentence = denialEvidencePresent
      ? `I am writing to formally appeal the denial of my claim for services rendered on ${formatDate(serviceDate)} by ${providerName}.`
      : `I am writing to formally dispute how my claim for services rendered on ${formatDate(serviceDate)} by ${providerName} was processed.`;

    const v3 = v3DesignOn ?? false;
    const reviewSection = v3
      ? ` The specific relief I am requesting is set out below, following the supporting detail.`
      : ` I am requesting a full review of this denial, including:\n\n1. The specific reason for denial, including the applicable plan provision or exclusion\n2. The clinical criteria used to determine medical necessity\n3. Instructions for requesting an external review if this internal appeal is denied`;
    const reliefSection = v3
      ? buildRequestSection({ evidence, planContext, recipient: "insurer", letterRecovery, recovery, noPlanCoverageRequestOn, demandsEnabled: disputeGroundsOn ?? false, gateUnverified: gateUnverified ?? false })
      : `${closingArgument ? `${closingArgument}\n\n` : ""}${escalationParagraph}`;

    return `${easternDate(new Date())}

${recipientBlock}

${claimIdHeader}

To Whom It May Concern:

${openingSentence}${planLabelSentence}

I believe the services provided were medically necessary and should be covered under my plan.${reviewSection}

${evidenceBlock ? `${evidenceBlock}\n` : ""}${reliefSection}

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
    v3DesignOn,
    disputeGroundsOn,
    attestingName,
    letterRecovery,
    holdCallAt,
    recovery,
    noPlanCoverageRequestOn,
    finAssistContext,
  }) => {
    const evidenceBlock = renderEvidenceBlock(
      evidence,
      planContext,
      "Why these charges appear inconsistent with my plan's cost-sharing terms",
      // S312 — provider bill view (see the overcharge template): charge-line rendering +
      // ask-gated citations + the sums block. Title unchanged (bb argues its own wrong).
      { gateUnverified: gateUnverified ?? false, attestingName: attestingName ?? patientName, v3DesignOn: v3DesignOn ?? false, disputeGroundsOn: disputeGroundsOn ?? false, recipient: "provider", recovery },
    );
    // S295 — the only unevidenced assertion left outside insurance_appeal. This
    // recital claimed the user had REVIEWED AN EOB and that an insurance payment
    // had been made — both of which a balance-billing letter drafted from a
    // provider bill alone cannot support, and the "allowed amount minus my
    // insurance payment" arithmetic is unknowable without one. Same gate as the
    // denial framing (hasAdjudicationEvidence). With an EOB present the sentence
    // is byte-identical; without one it drops to what the bill alone shows and
    // leaves the NSA ask below — already conditional voice — to carry the letter.
    const eobRecital = hasAdjudicationEvidence(evidence)
      ? "After reviewing my Explanation of Benefits and your bill, I have identified charges that exceed my plan's allowed amount minus my insurance payment."
      : "Reviewing your bill, I have identified charges that may exceed my in-network cost-sharing for these services.";
    // §18 incr-3 — finding block from EVIDENCE when ON (rerender-safe); OFF → byte-identical.
    const effectiveFindings: Array<AuditFinding | GroundFinding> =
      disputeGroundsOn && evidence ? groundFindingsForEvidence(evidence) : findings;
    const findingDetails = effectiveFindings
      .map(
        (f, i) =>
          `${i + 1}. ${f.title}\n   ${f.description ?? ""}`
      )
      .join("\n\n");

    const totalExcess = effectiveFindings.reduce(
      (sum, f) => sum + f.estimatedOvercharge,
      0
    );

    const recipientBlock = buildProviderRecipientBlock(providerName, planContext?.providerContact, bill);
    const patientRefBlock = buildPatientReferenceBlock(patientName, undefined, planContext?.providerContact, bill);

    // Block C2 item 4 — v3 replaces the fixed "I am requesting 1/2/3" list with
    // the conditional request tree (provider voice). OFF → byte-identical.
    const requestBlock = (v3DesignOn ?? false)
      ? buildRequestSection({ evidence, planContext, recipient: "provider", letterRecovery, recovery, noPlanCoverageRequestOn, finAssistContext, demandsEnabled: disputeGroundsOn ?? false, holdCallAt, gateUnverified: gateUnverified ?? false })
      : `I am requesting:

1. An immediate review of these charges
2. Adjustment of my bill to reflect only my legitimate cost-sharing obligations (copay, coinsurance, and deductible)
3. A corrected bill reflecting the appropriate patient responsibility

Please respond within 30 days. If I do not receive a satisfactory resolution, I intend to file complaints with my state insurance commissioner and the federal No Surprises Help Desk.`;

    return `${easternDate(new Date())}

${recipientBlock}

Re: Balance Billing Dispute — Date of Service: ${formatDate(serviceDate)}
${patientRefBlock}${renderGated(accountNumber, (a) => `\nAccount #: ${a}`)}

To Whom It May Concern:

I am writing to dispute what appears to be balance billing on my account for services rendered on ${formatDate(serviceDate)}.

${eobRecital} If these services are subject to the No Surprises Act (for example, emergency services, or services from an out-of-network provider at an in-network facility) or to applicable state balance-billing protections, I should not be billed beyond my in-network cost-sharing for covered services. Please confirm whether these protections apply to these charges and, to the extent they do, correct the balance accordingly.

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
${requestBlock}

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
    disputeGroundsOn,
    v3DesignOn,
    letterRecovery,
    holdCallAt,
    recovery,
    noPlanCoverageRequestOn,
    finAssistContext,
    bill,
  }) => {
    const evidenceBlock = renderEvidenceBlock(
      evidence,
      planContext,
      "Line items flagged as duplicates",
      // duplicate-letter body fn has no attestingName/v3DesignOn in scope → omitted (defaults "" /
      // false, exactly as the prior positional call relied on). R3 step 5.4 (1c).
      // S312 — provider bill view (see the overcharge template). Title unchanged.
      { gateUnverified: gateUnverified ?? false, disputeGroundsOn: disputeGroundsOn ?? false, recipient: "provider", recovery },
    );
    // §18 incr-3 — finding block from EVIDENCE when ON (rerender-safe); OFF → byte-identical.
    const effectiveFindings: Array<AuditFinding | GroundFinding> =
      disputeGroundsOn && evidence ? groundFindingsForEvidence(evidence) : findings;
    const findingDetails = effectiveFindings
      .map(
        (f, i) =>
          `${i + 1}. ${f.title}\n   ${f.description ?? ""}`
      )
      .join("\n\n");

    const totalDuplicate = effectiveFindings.reduce(
      (sum, f) => sum + f.estimatedOvercharge,
      0
    );

    const recipientBlock = buildProviderRecipientBlock(providerName, planContext?.providerContact, bill);
    const patientRefBlock = buildPatientReferenceBlock(patientName, undefined, planContext?.providerContact, bill);

    // R3 step 5.4 Phase 3 (Item A.2) — route the relief through the shared composer (v3), exactly
    // as overcharge/balance_billing do, so duplicate-led provider letters get the set-tier duplicate
    // asks + itemized + collections-hold instead of a generic fixed list. The legacy list is the
    // v3-OFF fallback (deprecated; prod runs v3 ON). buildRequestSection emits its own RELIEF
    // REQUESTED header + 30-day deadline + consequence. Gate on `evidence`: with none (a degraded
    // path / the evidence:null fixture variant) fall to the legacy list — duplicate has no separate
    // closing line, so an empty relief would read abruptly (unlike overcharge, which has one).
    const requestBlock = ((v3DesignOn ?? false) && evidence)
      ? buildRequestSection({ evidence, planContext, recipient: "provider", letterRecovery, recovery, noPlanCoverageRequestOn, finAssistContext, demandsEnabled: disputeGroundsOn ?? false, holdCallAt, gateUnverified: gateUnverified ?? false })
      : `I am requesting:

1. A detailed review of each charge listed above
2. Removal of any confirmed duplicate charges
3. A corrected bill reflecting the appropriate total

Please provide a written response within 30 days of receipt of this letter.`;

    return `${easternDate(new Date())}

${recipientBlock}

Re: Duplicate Charge Dispute — Date of Service: ${formatDate(serviceDate)}
${patientRefBlock}${renderGated(accountNumber, (a) => `\nAccount #: ${a}`)}

To Whom It May Concern:

I am writing to dispute what appear to be duplicate charges on my medical bill for services rendered on ${formatDate(serviceDate)}.

After reviewing my bill, I have identified the following charges that appear to be duplicated:

${findingDetails}

The total amount of suspected duplicate charges is ${formatCurrency(totalDuplicate)}.
${evidenceBlock ? `\n${evidenceBlock}` : ""}
${requestBlock}

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
    return `${easternDate(new Date())}

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

// ============================================================================
// dispute-letters v2 S2 — escalation + collections templates. All user-triggered
// (outcome-driven flow); fail-closed on gated clauses via renderGated; state
// citations inert (registry not shipped). Recipients: final_notice → provider
// Compliance, external_review → insurer Appeals, debt_validation → the collector.
// ============================================================================

const finalNoticeTemplate: LetterTemplate = {
  type: "final_notice",
  subject: (provider) => `Final Notice Before Escalation — ${provider}`,
  body: ({ patientName, providerName, serviceDate, accountNumber, planContext, bill, findings, priorContactRecital, certifiedMail }) => {
    const recipientBlock = buildProviderRecipientBlock(providerName, planContext?.providerContact, bill);
    const patientRefBlock = buildPatientReferenceBlock(patientName, undefined, planContext?.providerContact, bill);
    const total = (findings ?? []).reduce((s, f) => s + f.estimatedOvercharge, 0);
    const state = planContext?.userState ?? null;
    const certifiedLine = certifiedMail ? "\nSent via certified mail, return receipt requested" : "";
    const recital = renderGated(priorContactRecital, (r) => ` ${r}`);
    const amountLine = total > 0 ? ` The amount in dispute is ${formatCurrency(total)}.` : "";
    const forum = state
      ? `my state's consumer-protection authority (the ${state} Attorney General's office)`
      : "my state's consumer-protection authority";
    const stateCitation = renderGated(resolveStateCitation(state, "medical_debt"), (c) => ` ${c}`);
    return `${easternDate(new Date())}

${recipientBlock}

Re: Final Notice Before Escalation — Date of Service: ${formatDate(serviceDate)}
${patientRefBlock}${renderGated(accountNumber, (a) => `\nAccount #: ${a}`)}${certifiedLine}

To Whom It May Concern:

This is my final attempt to resolve the disputed charges on this account before I escalate.${recital}${amountLine}

Please respond in writing within 15 business days of receipt confirming the correction of these charges. While this dispute is unresolved, please do not refer this account to collections or report it to a credit bureau.

If this matter is not resolved, I intend to file complaints with ${forum} and, where applicable, the federal No Surprises Help Desk, and this unresolved dispute will be noted in those complaints.${stateCitation}

Sincerely,

${patientName}

---
DISCLAIMER: This letter was prepared using Candid, a consumer billing analysis tool. Candid is not a law firm, does not provide legal advice, and does not act as your legal representative. The information above is based on anonymized, aggregated community data and publicly available rates, and may not reflect your specific contractual rates or coverage.`;
  },
};

const externalReviewTemplate: LetterTemplate = {
  type: "external_review",
  subject: (provider) => `Request for External Review — ${provider}`,
  body: ({ patientName, serviceDate, accountNumber, planContext, appealExhausted }) => {
    const insurerName = planContext?.insurer?.name ?? "My Health Plan";
    const recipientBlock = buildInsurerRecipientBlock(insurerName, planContext);
    const denialLine = renderGated(appealExhausted?.denialDate, (d) => ` on ${formatDate(d)}`);
    return `${easternDate(new Date())}

${recipientBlock}

Re: Request for External Review — Date of Service: ${formatDate(serviceDate)}
Patient: ${patientName}${accountNumber ? `\nClaim/Account #: ${accountNumber}` : ""}

To Whom It May Concern:

I have completed your internal appeals process and received a final adverse determination${denialLine}. Under the Affordable Care Act (ACA §2719 / 45 CFR §147.136), I am entitled to an independent external review of this denial, and I am requesting one.

Enclosed with this request:
1. The final internal denial (adverse benefit determination)
2. My prior internal appeal
3. The Explanation of Benefits for the claim
4. Supporting documentation (medical records or provider letter, as applicable)

Please initiate the external review and confirm in writing the date this request was received and the external review organization to which it is assigned. If external review must instead be requested through my state Department of Insurance or the federal HHS-administered process, please advise so I can submit it there.

Sincerely,

${patientName}

---
DISCLAIMER: This letter was prepared using Candid, a consumer billing analysis tool. Candid is not a law firm, does not provide legal advice, and does not act as your legal representative. You should consult with a qualified attorney or patient advocate if you need assistance with your external review.`;
  },
};

const debtValidationTemplate: LetterTemplate = {
  type: "debt_validation",
  subject: () => `Debt Validation Request`,
  body: ({ patientName, accountNumber, planContext, collector, debtWithinWindow }) => {
    const recipientBlock = buildCollectorRecipientBlock(collector);
    const state = planContext?.userState ?? null;
    const creditor = renderGated(collector?.originalCreditor, (oc) => ` (original creditor: ${oc})`);
    const acctLine = renderGated(accountNumber, (a) => ` — Account #: ${a}`);
    const validationTeeth = debtWithinWindow
      ? `\n\nUnder the Fair Debt Collection Practices Act (15 U.S.C. §1692g), please provide: (1) the amount of the debt; (2) the name of the original creditor; and (3) verification that the debt is valid and that you are authorized to collect it, together with an itemized statement of the charges.`
      : "";
    const cease = debtWithinWindow
      ? `\n\nUntil you provide the requested validation, please cease collection activity on this account.`
      : "";
    const stateCitation = renderGated(resolveStateCitation(state, "credit_furnishing"), (c) => ` ${c}`);
    return `${easternDate(new Date())}

${recipientBlock}

Re: Debt Validation Request${acctLine}${creditor}

To Whom It May Concern:

I am writing regarding the above account. I dispute this debt and request validation. This letter is not an acknowledgment that I owe this debt.

Please provide validation of this debt, including documentation that it is valid and that the amount is accurate.${validationTeeth}

Please mark this debt as disputed in your records and in any report you make to a consumer reporting agency, as required by the Fair Debt Collection Practices Act (15 U.S.C. §1692e(8)).${stateCitation}${cease}

Sincerely,

${patientName}

---
DISCLAIMER: This letter was prepared using Candid, a consumer billing analysis tool. Candid is not a law firm, does not provide legal advice, and does not act as your legal representative. You should consult with a qualified attorney if you need legal advice regarding this debt.`;
  },
};

export const LETTER_TEMPLATES: Record<DisputeLetterType, LetterTemplate> = {
  overcharge: overchargeTemplate,
  itemized_request: itemizedRequestTemplate,
  insurance_appeal: insuranceAppealTemplate,
  balance_billing: balanceBillingTemplate,
  duplicate_charge: duplicateChargeTemplate,
  negotiation: negotiationTemplate,
  final_notice: finalNoticeTemplate,
  external_review: externalReviewTemplate,
  debt_validation: debtValidationTemplate,
};
