/**
 * Evidence Package Compiler — assembles all Candid data into a court-ready document.
 *
 * Reworked for t_dispute_letter_redesign Phase 5 to share the
 * evidence-resolver with the dispute-letter pipeline:
 *   - Section 0 is the full dispute letter verbatim (when provided)
 *   - Every other section pulls from a single DisputeEvidence object so
 *     the letter and Case File can never drift.
 *   - Plan Coverage Evidence includes the same citations (+ direct SBC
 *     quotes when available from Phase 4.5).
 *
 * Back-compat: the existing legacy callers pass only `{ claimId, userId }`;
 * they still work. New callers pass `{ claimId, userId, disputeId,
 * letterContent, planContext, evidence }` for the richer package.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { DISCLAIMERS } from "./disclaimers";
import type { PlanContext } from "@/lib/disputes/plan-context";
import type { DisputeEvidence, LineItemEvidence } from "@/lib/disputes/evidence-resolver";
import { resolvePlanContext } from "@/lib/disputes/plan-context";
import { resolveEvidence } from "@/lib/disputes/evidence-resolver";
import { normalizeCoinsurancePct } from "@/lib/billing/coinsurance";
import { formatDate } from "@/lib/disputes/templates";
import { adjudicationBand } from "@/lib/care/interface";
import type { OriginalDocument } from "./attach-originals";
import { loadCaseProjection } from "@/lib/case/load-case-timeline";
import { guidedCallLogFromMeta, type GuidedCallLogEntry } from "@/lib/guides/pack-registry";
import { genuineSends, type GenuineSend } from "@/lib/disputes/prior-contact";
import type { ProjectedLetterStep, ProjectedRegulatorComplaint } from "@/lib/case/timeline-projector";
import { COMPLAINT_DOORS } from "@/lib/guides/pack-registry";
import { letterRailCopy } from "@/lib/guides/pack-registry";
import { FORUM_BY_ID } from "@/lib/disputes/forums";

export interface EvidenceSection {
  /**
   * Stable identity, independent of the printed number (S305).
   *
   * The PDF renderer used to special-case sections by `title.startsWith("1.")`
   * — so the moment the document renumbered, it discarded the new section 1's
   * content and rendered a table built for the old one. A section's identity is
   * not its position; renderers key on this.
   */
  key: string;
  title: string;
  content: string;
  disclaimer: string;
}

export interface EvidencePackage {
  title: string;
  generatedAt: string;
  masterDisclaimer: string;
  sections: EvidenceSection[];
  // Extended fields for the redesigned Case File. Older consumers (plain-text
  // formatter) ignore these; the PDF renderer + admin UI use them.
  planContext?: PlanContext | null;
  evidence?: DisputeEvidence | null;
  letterContent?: string | null;
  /**
   * S305 — the source files this package's exhibit list promises, with the
   * labels it printed. The PDF route binds these in AFTER the composed pages;
   * exposing them here means the binder cannot label an exhibit differently
   * from the list that names it.
   */
  originals?: OriginalDocument[];
}

interface CompileParams {
  claimId: string;
  userId: string;
  disputeId?: string;
  /** Full dispute letter body to embed as Section 0. */
  letterContent?: string | null;
  /** Pre-resolved plan context; resolver falls back when omitted. */
  planContext?: PlanContext | null;
  /** Pre-resolved DisputeEvidence; resolver falls back when omitted. */
  evidence?: DisputeEvidence | null;
  /**
   * The dispute's explicit user override, threaded into the internal
   * resolvePlanContext fallback (when planContext isn't pre-resolved) so the
   * legal package cites the plan the user chose, else the claim's DOS-correct
   * plan.
   */
  pinnedInsurancePlanId?: string | null;
}

/**
 * SECURITY CONTRACT: callers MUST pass an ownership-validated `claimId` (verified
 * to belong to `userId`). Sections 2 + 5 read claim-keyed tables and the resolvers
 * read by claimId; this fn does NOT re-verify claim ownership. Enforced today by
 * the route (assertOwnership before this call); B1 will make it structural.
 */
export async function compileEvidencePackage(
  supabase: SupabaseClient,
  params: CompileParams,
): Promise<EvidencePackage> {
  // `disputeId` is deliberately no longer read: the Case File is the CLAIM's
  // record and walks every SENT letter, so it never embeds one caller-chosen
  // letter — and the old Section 0 embedded an unsent draft, which spec §5
  // decision 6 excludes outright. The param stays on CompileParams for the
  // route's plan-pinning path.
  const { claimId, userId, letterContent } = params;

  // Resolve plan context + evidence once, share across sections.
  const planContext = params.planContext ?? (await resolvePlanContext(supabase, {
    userId,
    claimId,
    pinnedInsurancePlanId: params.pinnedInsurancePlanId,
  }));
  const evidence = params.evidence ?? (await resolveEvidence(supabase, {
    userId,
    claimIds: [claimId],
    planContext,
    letterType: "insurance_appeal",
  }));

  const claim = evidence.claims[0] ?? null;

  // The claim row carries the patient block and the guided-step attestations.
  const { data: claimRow } = await supabase
    .from("claims")
    .select("metadata, total_patient_responsibility")
    .eq("id", claimId)
    .maybeSingle();

  // The case's own record — letters, sends, outcomes, regulator filings. Loaded
  // here so the Case File composes from the SAME projection the rail and the
  // letters read; `null` before the first letter, which is honest (there is no
  // case yet) and simply omits the sections that describe one.
  const caseProjection = await loadCaseProjection(supabase, userId, claimId);
  const projected = caseProjection?.projected ?? null;
  const claimMeta = (claimRow?.metadata as Record<string, unknown> | null) ?? null;
  const callLog = guidedCallLogFromMeta(
    (claimMeta?.guideSteps as Record<string, { checkedAt?: string | null; note?: string }> | undefined) ?? null,
  );

  // Only SENT letters reach a lawyer (spec §5 decision 6): an unsent draft is
  // not a contact, and the recital already applies the same rule (§0.9b).
  const sends = projected ? genuineSends(projected.history, projected.letters) : [];
  const sentDisputeIds = new Set(sends.map((x) => x.disputeId));
  const sentLetters = (projected?.letters ?? []).filter((l) => sentDisputeIds.has(l.disputeId));

  // The claim's source document — the bill or EOB the user uploaded.
  // `claims.source_document_id` is the only structural link between a claim and
  // a file, so it is the only original we can assert belongs to this case.
  let sourceDoc: { id: string; file_name: string | null; storage_path: string } | null = null;
  {
    const { data: cRow } = await supabase
      .from("claims")
      .select("source_document_id")
      .eq("id", claimId)
      .maybeSingle();
    const docId = (cRow?.source_document_id as string | null) ?? null;
    if (docId) {
      const { data: dRow } = await supabase
        .from("documents")
        .select("id, file_name, storage_path")
        .eq("id", docId)
        .maybeSingle();
      if (dRow?.storage_path) {
        sourceDoc = {
          id: dRow.id as string,
          file_name: (dRow.file_name as string | null) ?? null,
          storage_path: dRow.storage_path as string,
        };
      }
    }
  }

  // The letters' own text, for §10. Loaded only for letters that were actually
  // sent, so an unsent draft cannot reach the document by this path either.
  const letterBodies = new Map<string, string>();
  if (sentLetters.length > 0) {
    const { data: bodies } = await supabase
      .from("dispute_outcomes")
      .select("id, letter_content")
      .eq("claim_id", claimId)
      .in("id", sentLetters.map((l) => l.disputeId));
    for (const b of bodies ?? []) {
      if (typeof b.letter_content === "string" && b.letter_content.trim()) {
        letterBodies.set(b.id as string, b.letter_content);
      }
    }
  }

  // Gaps that undercut a later section get promoted to the cover sheet
  // (spec §5 decision 5) rather than waiting for the reader to reach them.
  const coverGaps: string[] = [];
  const dosYear = claim?.dateOfService ? Number(String(claim.dateOfService).slice(0, 4)) : null;
  const planYear = planContext?.plan?.planYear ?? null;
  if (dosYear != null && planYear != null && Number(planYear) !== dosYear) {
    coverGaps.push(
      `The plan on file is for the ${planYear} plan year; the service was ${fmtDay(claim!.dateOfService)}. The coverage terms quoted below are from a plan year that does not match the date of service.`,
    );
  }
  if (claim && claim.lineItemEvidence.some((li) => li.insurancePaid == null)) {
    coverGaps.push(
      "The bill states no insurer payment for at least one service. Those fields are shown blank below rather than inferred.",
    );
  }

  // ── The document ─────────────────────────────────────────────────────────
  //
  // ONE ordered list. Every builder returns null when it has nothing to say and
  // is dropped — the no-data rule is structural here, not remembered at each
  // site. The two deliberate exceptions are the bill's blank columns and "what
  // is still missing", whose subject IS the absence (spec §2.2 / §3 rule 4).
  const drafted: Array<EvidenceSection | null> = [
    sec("at_a_glance", "At a glance", [
      kv("Amount at stake", money(numOrNull(claimRow?.total_patient_responsibility))),
      kv("Patient", (claimMeta?.patient as { name?: string } | undefined)?.name ?? "—"),
      kv("Provider", claim?.providerName ?? "—"),
      kv("Insurer", [planContext?.insurer?.name ?? planContext?.plan?.insurerName, planContext?.plan?.planName].filter(Boolean).join(" — ") || "—"),
      kv("Date of service", fmtDay(claim?.dateOfService ?? null)),
      kv("Posture", posture(sentLetters)),
      kv("Exhaustion", exhaustion(sentLetters)),
      coverGaps.length ? "\n" + coverGaps.map((g) => `  Gap: ${g}`).join("\n") : "",
    ]),

    sec("deadlines", "Deadlines", sentLetters
      .filter((l) => l.responseDueDate && l.deadlineType)
      .map((l) => [
        `  • ${deadlineLabel(l.deadlineType!)}: ${fmtDay(l.responseDueDate!)}`,
        `      Computed from: ${letterNoun(l.letterType)} mailed ${fmtDay(l.latestSendAt)}`,
        `      Status: ${l.outcome ? `answered ${fmtDay(l.outcome.loggedAt)}` : "outstanding"}`,
      ].join("\n")).join("\n\n")),

    sec("chronology", "What happened, in order", chronology(sends, sentLetters, callLog, projected?.regulator ?? null)),

    sec("the_bill", "The bill", claim ? billSection(claim) : "", DISCLAIMERS.discrepancy_alert),

    sec("coverage", "Coverage", claim
      ? (() => {
          const bullets = claim.lineItemEvidence.filter((li) => li.planBenefit).map(renderCoverageBullet).join("\n\n");
          return bullets ? `Plan terms as written, against what was charged:\n\n${bullets}` : "";
        })()
      : "", DISCLAIMERS.coverage_check),

    sec("governing_law", "The governing law", evidence.legalBasis
      .map((l) => `  • ${l.statute}: ${l.summary}${l.appliesTo.length ? ` (supports: ${l.appliesTo.join(", ")})` : ""}`)
      .join("\n")),

    sec("comparable", "Comparable claims and charges", comparable(claim, evidence), DISCLAIMERS.pricing_care),

    sec("regulator", "Regulator complaints", regulatorSection(projected?.regulator ?? null, sentLetters)),

    sec("still_missing", "What is still missing", stillMissing(evidence, coverGaps)),

    sec("exhibits", "Exhibits", exhibits(sentLetters, letterBodies, sourceDoc)),
  ];

  // Numbering is assigned AFTER omission so the document always reads 1..N with
  // no holes. Exhibits cross-reference by letter (A, B, C), never by section
  // number, so a dropped section cannot break a citation.
  const sections: EvidenceSection[] = numberSections(drafted);

  return {
    title: `Candid Case File — Claim ${claimId.slice(0, 8)}`,
    generatedAt: new Date().toISOString(),
    masterDisclaimer: DISCLAIMERS.small_claims,
    sections,
    planContext,
    evidence,
    letterContent: letterContent ?? null,
    originals: sourceDoc
      ? [
          {
            label: exhibitLabel(sentLetters.length),
            fileName: sourceDoc.file_name ?? "uploaded document",
            storagePath: sourceDoc.storage_path,
          },
        ]
      : [],
  };
}


/**
 * Drop the omitted sections, then number what survives — in that order.
 *
 * Numbering AFTER omission is what keeps the document reading 1..N with no
 * holes on a thin case. Exhibits cross-reference by letter (A, B, C), never by
 * section number, so nothing can be broken by a section dropping out.
 */
export function numberSections(drafted: Array<EvidenceSection | null>): EvidenceSection[] {
  return drafted
    .filter((x): x is EvidenceSection => x !== null)
    .map((x, i) => ({ ...x, title: `${i + 1}. ${x.title}` }));
}

// ── Case File composition helpers (S305) ───────────────────────────────────
//
// Every one returns "" or null when it has nothing to say, so the ordered list
// above drops it. That is the whole no-data rule: a heading whose content is
// its own emptiness is filler in a document a lawyer relies on.

/** A section, or null when there is nothing to put in it. */
export function sec(key: string, title: string, content: string | string[], disclaimer = ""): EvidenceSection | null {
  const joined = Array.isArray(content) ? content.filter(Boolean).join("\n") : content;
  // Trim only the ENDS of the block — `.trim()` ate the first line's indentation,
  // so the opening row of every section hung left of the rest.
  const body = joined.replace(/^\n+/, "").replace(/\s+$/, "");
  return body.trim() ? { key, title, content: body, disclaimer } : null;
}

function kv(label: string, value: string): string {
  return `  ${label.padEnd(22)}${value}`;
}

function numOrNull(v: unknown): number | null {
  return v == null ? null : Number(v);
}

/**
 * ⚠ Never coerces absence to zero. The compiler used to render
 * `formatUsd(x ?? 0)`, so a bill that states no insurer payment printed
 * "$0.00" to a lawyer — an asserted figure the document does not have. Same
 * defect S304 removed from persist; an absent number is evidence and says so.
 */
function money(n: number | null | undefined): string {
  return n == null ? "not stated" : formatUsd(n);
}

/**
 * The letters' own date formatter, plus a null rule.
 *
 * `formatDate` already pins to UTC, and its S109 comment says why: this compiles
 * SERVER-side, where "local" is the server's timezone and not the user's, and a
 * legal artifact must render the same date for whoever generates it. Reused
 * rather than reimplemented so the Case File and the letters beside it can never
 * name different days for the same act.
 */
function fmtDay(iso: string | null | undefined): string {
  if (!iso) return "not stated";
  if (Number.isNaN(Date.parse(iso))) return "not stated";
  return formatDate(iso);
}

function letterNoun(letterType: string): string {
  return letterRailCopy(letterType).receiptNoun.toLowerCase();
}

function posture(sent: ProjectedLetterStep[]): string {
  if (sent.length === 0) return "No letters sent";
  const answered = sent.filter((l) => l.outcome != null).length;
  return `${sent.length} letter${sent.length === 1 ? "" : "s"} sent; ${answered} answered`;
}

/**
 * Attested-only: exhaustion is read from what the user LOGGED, never inferred
 * from the absence of a next step.
 */
function exhaustion(sent: ProjectedLetterStep[]): string {
  const appeal = sent.find((l) => l.letterType === "insurance_appeal");
  const external = sent.find((l) => l.letterType === "external_review");
  const parts: string[] = [];
  if (appeal) parts.push(appeal.outcome ? "internal appeal answered" : "internal appeal outstanding");
  if (external) parts.push(external.outcome ? "external review answered" : "external review outstanding");
  return parts.length ? parts.join("; ") : "no insurer-track letter sent";
}

function deadlineLabel(deadlineType: string): string {
  switch (deadlineType) {
    case "plan_response": return "Plan response to the appeal";
    case "fdcpa_validation_30": return "Debt-validation response (FDCPA §1692g)";
    case "erisa_appeal_180": return "Deadline to file the appeal (ERISA)";
    default: return deadlineType.replace(/_/g, " ");
  }
}

/**
 * §3 — one row per act, each naming its own SOURCE. That column is the spine:
 * "the insurer denied the appeal" and "denied in full, as reported by the
 * patient" are different evidence and a lawyer must see which they are getting.
 */
function chronology(
  sends: GenuineSend[],
  sent: ProjectedLetterStep[],
  callLog: GuidedCallLogEntry[],
  regulator: ProjectedRegulatorComplaint | null,
): string {
  const rows: Array<{ at: string; line: string }> = [];
  const exhibitOf = new Map(sent.map((l, i) => [l.disputeId, String.fromCharCode(65 + i)]));

  for (const c of callLog) {
    rows.push({
      at: c.calledAt,
      line: `  ${fmtDay(c.calledAt)} — patient telephoned${c.note ? ` — ${c.note}` : ""}\n      Source: patient attestation`,
    });
  }
  for (const s of sends) {
    const l = sent.find((x) => x.disputeId === s.disputeId);
    rows.push({
      at: s.occurredAt,
      line: `  ${fmtDay(s.occurredAt)} — ${l ? letterNoun(l.letterType) : "letter"} mailed to the ${s.recipientKind}\n      Source: send record${exhibitOf.get(s.disputeId) ? ` · Exhibit ${exhibitOf.get(s.disputeId)}` : ""}`,
    });
  }
  for (const l of sent) {
    if (!l.outcome?.loggedAt) continue;
    rows.push({
      at: l.outcome.loggedAt,
      line: `  ${fmtDay(l.outcome.loggedAt)} — response to the ${letterNoun(l.letterType)}: ${l.outcome.detail.replace(/_/g, " ")}\n      Source: as reported by the patient`,
    });
  }
  for (const f of regulator?.filings ?? []) {
    const door = COMPLAINT_DOORS.find((d) => d.id === f.doorId);
    rows.push({
      at: f.filedAt,
      line: `  ${fmtDay(f.filedAt)} — complaint filed with ${door?.name ?? f.doorId}${f.note ? `, confirmation ${f.note}` : ""}\n      Source: patient attestation`,
    });
  }

  if (rows.length === 0) return "";
  const body = rows.sort((a, b) => a.at.localeCompare(b.at)).map((r) => r.line).join("\n\n");
  // Ceiling stated, not hidden (spec §3 rule 4 / tracker Item Z).
  return `${body}\n\n  Note: our record holds one call attestation per kind, so this list shows that a call was made — not how many. If more than one call took place, it is not recorded here.`;
}

/**
 * Where a total came from, in plain words (spec §2.2's table).
 *
 * A figure a lawyer may rely on has to say whether it was itemised, taken from
 * the bill's own summary because the lines do not sum to it, or supplied by the
 * patient — those are different evidence.
 */
function provenanceOf(source: string | undefined): string {
  switch (source) {
    case "per_line_sum": return "   (from the itemised lines)";
    case "claim_header": return "   (from the bill's own summary — the lines do not sum to it)";
    case "user_summary":
    case "user_line_items": return "   (confirmed by the patient)";
    default: return "";
  }
}

/** §4 — every field the bill carries, INCLUDING the ones it leaves blank. */
function billSection(claim: DisputeEvidence["claims"][number]): string {
  const lines = claim.lineItemEvidence
    .map((li, i) => [
      `  ${i + 1}. ${li.serviceName}${li.billingCode ? ` (${li.billingCode.type} ${li.billingCode.value})` : ""}`,
      `      Billed:                 ${money(li.billedAmount)}`,
      `      Insurer paid:           ${money(li.insurancePaid)}`,
      `      Patient responsibility: ${money(li.patientOwes)}`,
      `      Patient paid:           ${money(li.patientPaid)}`,
    ].join("\n"))
    .join("\n\n");
  // Every total, each naming its OWN source (spec §2.2). Billed alone was the
  // first cut and it dropped the two figures the bill's summary actually
  // states — a lawyer reading "not stated" per line and no total would
  // conclude the record has nothing, when the bill's own summary has both.
  const t = claim.effectiveTotals;
  const totals = [
    `      Billed:                 ${money(claim.totalBilled)}`,
    `      Plan discount:          ${money(t?.insuranceAdjusted ?? null)}${provenanceOf(t?.provenance.insuranceAdjustedSource)}`,
    `      Insurer paid:           ${money(t?.insurancePaid ?? null)}${provenanceOf(t?.provenance.insurancePaidSource)}`,
    `      Patient responsibility: ${money(t?.patientResponsibility ?? null)}${provenanceOf(t?.provenance.patientResponsibilitySource)}`,
    `      Patient paid:           ${money(t?.patientPaid ?? null)}${provenanceOf(t?.provenance.patientPaidSource)}`,
  ].join("\n");

  const single = claim.lineItemEvidence.length === 1;
  const note = single
    ? "  Single-line bill: each summary figure equals its line exactly."
    : "  Where a per-line figure was not stated on the bill, it is shown blank rather than allocated.";
  return `${lines}\n\n  Totals\n${totals}\n\n${note}`;
}

/**
 * §7 — evidence from outside this claim, and the ONE place anonymity is
 * enforced. Nothing countable is printed: no sample sizes, no percentages, no
 * thresholds. A percentage IS the sub-count when the sample is small (60% reads
 * back as three of five), which is why adjudication is banded rather than rated.
 */

function comparable(claim: DisputeEvidence["claims"][number] | null, evidence: DisputeEvidence): string {
  const out: string[] = [];
  const cv = evidence.communityEvidence;
  const median = cv?.pricingBenchmarks?.communityMedian ?? null;
  if (median != null) {
    out.push(`  Comparable charges: median billed amount for this service, from anonymized Candid member reports — ${formatUsd(median)}`);
  }
  for (const li of claim?.lineItemEvidence ?? []) {
    const co = li.communityOutcome;
    if (!co) continue;
    const band = adjudicationBand(co.paidCount, co.totalClaims);
    if (band) out.push(`  ${li.serviceName}: this code is ${band} on this plan`);
  }
  return out.join("\n");
}

function regulatorSection(regulator: ProjectedRegulatorComplaint | null, sent: ProjectedLetterStep[]): string {
  const filings = regulator?.filings ?? [];
  if (filings.length === 0) return "";
  return filings
    .map((f) => {
      // S325 — routed doors (forum_menu_v1) file under verified-forum ids
      // (e.g. "ca_dmhc_complaint"); the registry resolves those, and the
      // legacy projection resolves the four generic ids. Same prefix-scanned
      // record either way — a filing never loses its name.
      const forum = FORUM_BY_ID[f.doorId];
      const door = forum
        ? { name: forum.agency }
        : COMPLAINT_DOORS.find((d) => d.id === f.doorId);
      const about = sent.find((l) => l.disputeId === f.disputeId);
      return `  • ${door?.name ?? f.doorId} — filed ${fmtDay(f.filedAt)}${f.note ? `, confirmation ${f.note}` : ""}${about ? `\n      About: the ${letterNoun(about.letterType)}` : ""}`;
    })
    .join("\n");
}

/** §9 — each gap names who can supply it. This is the section that makes the rest useful. */
function stillMissing(evidence: DisputeEvidence, coverGaps: string[]): string {
  const rows = evidence.gaps.map((g) => `  • ${g.title}${g.description ? `\n      ${g.description}` : ""}\n      Who can supply it: ${gapOwner(g.kind)}`);
  for (const g of coverGaps) rows.push(`  • ${g}\n      Who can supply it: the patient`);
  rows.push("  • Whether more than one call was made, and to whom\n      Who can supply it: the patient — our record cannot hold it");
  return rows.join("\n\n");
}

function gapOwner(kind: string): string {
  if (kind.includes("provider")) return "the provider";
  if (kind.includes("insurer") || kind.includes("eob") || kind.includes("denial")) return "the insurer";
  if (kind.includes("plan")) return "the patient (or the insurer)";
  return "the patient";
}

/**
 * §10 — the letters themselves, in full. Unsent drafts are excluded entirely
 * (spec §5 decision 6).
 *
 * ⚠ The bodies are EMBEDDED, not listed. The pre-reshape compiler had a
 * "Section 0" that embedded exactly ONE letter — whichever the caller named —
 * and the reshape dropped it, which would have shipped a case file that lists
 * three exhibits and contains none of them. A lawyer cannot read a filename.
 */
function exhibitLabel(i: number): string {
  return String.fromCharCode(65 + i);
}

function exhibits(
  sent: ProjectedLetterStep[],
  bodyByDispute: Map<string, string>,
  sourceDoc: { file_name: string | null; storage_path: string } | null,
): string {
  if (sent.length === 0 && !sourceDoc) return "";
  const letterBlocks = sent
    .map((l, i) => {
      const label = `  Exhibit ${exhibitLabel(i)} — ${letterRailCopy(l.letterType).receiptNoun} as mailed ${fmtDay(l.latestSendAt)}`;
      const body = bodyByDispute.get(l.disputeId);
      if (!body) {
        // Named, never dropped silently (spec §5 decision 4).
        return `${label}\n      Gap: the text of this letter is not on file and could not be attached.`;
      }
      const indented = body.trim().split("\n").map((ln) => `      ${ln}`).join("\n");
      return `${label}\n\n${indented}\n\n      — end of Exhibit ${exhibitLabel(i)} —`;
    })
    .join("\n\n");

  // The uploaded original continues the SAME label sequence. In the PDF the
  // file itself is bound in after the composed pages; in plain text it can only
  // be named, which the line says rather than implying an attachment.
  if (!sourceDoc) return letterBlocks;
  const label = exhibitLabel(sent.length);
  const name = sourceDoc.file_name ?? "uploaded document";
  const originalBlock = `  Exhibit ${label} — ${name} (the document as uploaded; attached in full to the PDF edition)`;
  return letterBlocks ? `${letterBlocks}\n\n${originalBlock}` : originalBlock;
}

function renderCoverageBullet(li: LineItemEvidence): string {
  const b = li.planBenefit;
  if (!b) return "";
  const parts: string[] = [];
  parts.push(`  • ${li.serviceName}${li.billingCode ? ` (${li.billingCode.type} ${li.billingCode.value})` : ""}`);
  if (b.copay != null) parts.push(`      Copay: ${formatUsd(b.copay)}`);
  if (b.coinsurance != null) parts.push(`      Coinsurance: ${normalizeCoinsurancePct(b.coinsurance)}%`);
  parts.push(`      Citation: ${b.citation}`);
  if (b.sbcExcerpt) parts.push(`      SBC quote: "${b.sbcExcerpt.trim()}"`);
  return parts.join("\n");
}

function formatUsd(n: number): string {
  const v = Math.round(n * 100) / 100;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatEvidencePackageAsText(pkg: EvidencePackage): string {
  const divider = "═".repeat(60);
  const thinDivider = "─".repeat(60);

  let text = `${divider}
${pkg.title}
Generated: ${new Date(pkg.generatedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
${divider}

IMPORTANT DISCLAIMER:
${pkg.masterDisclaimer}

${divider}

`;

  for (const section of pkg.sections) {
    text += `${section.title}\n${thinDivider}\n\n${section.content}\n`;
    if (section.disclaimer) {
      text += `\n[Note: ${section.disclaimer}]\n`;
    }
    text += `\n`;
  }

  text += `${divider}\nEnd of Evidence Package\n${divider}\n`;
  return text;
}
