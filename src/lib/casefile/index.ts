// Candid Case File Compiler
// Compiles an audit letter + supporting evidence into a comprehensive downloadable document.
// This is the core Beta: Paid Candid Claim — documentation aggregation feature.

import type { DisputeLetter } from "@/lib/billing/types";
import { easternDate } from "@/lib/format/dates";

const ESCALATION_GUIDE = `WHAT TO DO NEXT
---------------
1. Print or save a copy of this entire document for your records.
2. Send the dispute letter in Section 2 directly to the recipient listed.
   - Send via certified mail with return receipt (USPS Form 3811) so you have
     proof of delivery.
   - Email is acceptable for insurance appeals — check your plan's appeal portal.
3. Keep a copy of your signed letter, this case file, and your original bill.
4. Follow up if you do not receive a written response within 30 days.

IF YOU DO NOT RECEIVE A RESPONSE IN 30 DAYS
--------------------------------------------
Provider billing disputes:
  - Escalate to your state's Department of Insurance or Attorney General.
  - File a complaint at cms.gov (for Medicare) or your state insurance commissioner.

Insurance denials:
  - Request an external independent review (IRO) through your state marketplace.
  - File a complaint with the U.S. Department of Labor (employer plans) or
    your state insurance commissioner (individual/marketplace plans).

Balance billing violations:
  - Report to your state Attorney General's consumer protection office.
  - File a complaint at consumerfinance.gov/complaint (if in collections).

For disputes involving $500 or more, consider consulting a healthcare billing
attorney. Candid Case (coming soon) will connect you with specialists in your state.`;

const DISCLAIMER = `LEGAL DISCLAIMER
----------------
Candid is not a healthcare provider, law firm, or insurance company. All outputs
are informational only and do not constitute legal, medical, or financial advice.

Review your dispute letter carefully before sending. For disputes involving
significant amounts or complex legal issues, consult a licensed attorney in your
state. Candid does not submit letters on your behalf — you must send this yourself.

Candid is an Airgetlam Labs LLC company.`;

// S309 F13 — both are INSTANTS (letter.createdAt): the Eastern clock, not the
// server's local zone (which silently varied between Vercel-UTC and the dev
// machine). Fail-closed shells preserved.
function formatDate(iso: string): string {
  try {
    return easternDate(iso);
  } catch {
    return iso;
  }
}

function followUpDate(iso: string): string {
  try {
    const d = new Date(iso);
    d.setDate(d.getDate() + 30);
    return easternDate(d);
  } catch {
    return "30 days from today";
  }
}

function hr(char = "=", width = 62): string {
  return char.repeat(width);
}

export function compileCaseFile(letter: DisputeLetter): string {
  const generated = formatDate(letter.createdAt);
  const followUp = followUpDate(letter.createdAt);
  const letterTypeLabel = letter.letterType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  const lines: string[] = [
    "CANDID — MEDICAL BILLING DISPUTE CASE FILE",
    `Prepared: ${generated}`,
    "Candid is an Airgetlam Labs LLC company.",
    "",
    hr(),
    "IMPORTANT — READ BEFORE SENDING",
    hr(),
    "",
    "This case file was prepared by Candid to help you dispute a medical billing",
    "error or insurance issue. Keep a copy of this document. You must send the",
    "letter in Section 2 yourself — Candid does not file on your behalf.",
    "",
    `  30-day follow-up date: ${followUp}`,
    `  Dispute type:          ${letterTypeLabel}`,
    `  Send to:               ${letter.recipient.name} — ${letter.recipient.role}`,
    "",
    hr(),
    "SECTION 1 — AUDIT SUMMARY",
    hr(),
    "",
    `Subject: ${letter.subject}`,
    "",
    `Requested action: ${letter.requestedAction}`,
    "",
  ];

  if (letter.legalBasis) {
    lines.push(`Legal basis: ${letter.legalBasis}`, "");
  }

  if (letter.supportingFacts.length > 0) {
    lines.push("Findings identified by Candid:", "");
    letter.supportingFacts.forEach((fact, i) => {
      lines.push(`  ${i + 1}. ${fact}`);
    });
    lines.push("");
  }

  lines.push(
    hr(),
    "SECTION 2 — DISPUTE LETTER (SEND THIS)",
    hr(),
    "",
    `To: ${letter.recipient.name}`,
    `    ${letter.recipient.role}`,
  );

  if (letter.recipient.address) {
    lines.push(`    ${letter.recipient.address}`);
  }

  lines.push("", `Subject: ${letter.subject}`, "");
  lines.push(letter.body);
  lines.push("");

  lines.push(
    hr(),
    "SECTION 3 — EVIDENCE LOG",
    hr(),
    "",
    "The following issues were identified by Candid's audit engine:",
    "",
  );

  if (letter.supportingFacts.length > 0) {
    letter.supportingFacts.forEach((fact, i) => {
      lines.push(`  ${i + 1}. ${fact}`);
    });
  } else {
    lines.push("  No specific audit findings — see letter body for details.");
  }

  lines.push(
    "",
    hr(),
    "SECTION 4 — NEXT STEPS & ESCALATION GUIDE",
    hr(),
    "",
    ESCALATION_GUIDE,
    "",
    hr(),
    DISCLAIMER,
    "",
    `Generated by Candid on ${generated}.`,
  );

  return lines.join("\n");
}

export function downloadCaseFile(letter: DisputeLetter): void {
  const content = compileCaseFile(letter);
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `candid-case-file-${new Date().toISOString().slice(0, 10)}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
