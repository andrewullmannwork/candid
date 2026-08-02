/**
 * prior-contact fixture (S300, tracker Item N) — the ONE contact recital.
 *
 * Locks the things that would put a FALSE STATEMENT in a letter the user
 * signs, plus the consolidation's behavior-preservation:
 *   · recipient matching — a provider letter never recites insurer-directed
 *     sends as "I wrote to YOU" (the defect that made this a correctness job,
 *     not a scope widening)
 *   · unsend netting (§0.9b) — a marked-sent-then-unsent letter was never
 *     mailed and is never recited
 *   · the composing letter's own not-yet-sent draft is excluded
 *   · other-track clause ONLY on an ATTESTED conclusion — absence of a logged
 *     outcome is not evidence of silence
 *   · `signoff` variant is byte-equal to the S297 call recital it absorbed
 *   · singular/plural collapse, same-day dedupe, and no-contact → ""
 *
 * Run:  npx tsx scripts/calibration/fixtures/dispute-grounds/prior-contact.ts
 */
import { buildPriorContactRecital } from "../../../../src/lib/disputes/prior-contact";
import type {
  ProjectedHistoryEntry,
  ProjectedLetterStep,
} from "../../../../src/lib/case/timeline-projector";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}${got !== undefined ? `  (got: ${JSON.stringify(got)})` : ""}`);
}

const PROVIDER_LETTER = "d-prov";
const INSURER_LETTER = "d-ins";
const FINAL_NOTICE = "d-final";

function letter(
  disputeId: string,
  letterType: string,
  recipientKind: "provider" | "insurer" | "collector",
  outcome?: { detail: string; loggedAt: string | null },
): ProjectedLetterStep {
  return {
    disputeId,
    letterType,
    recipientKind,
    startAt: "2026-06-01T00:00:00.000Z",
    stage: "awaiting",
    hasNextStep: false,
    latestSendAt: null,
    sendCount: 0,
    unsendCount: 0,
    redraftCount: 0,
    responseDueDate: null,
    deadlineType: null,
    counterpartyName: null,
    mailedCertified: false,
    regulatorFiled: false,
    regulatorFiledNote: null,
    outcome: outcome
      ? { detail: outcome.detail as never, status: "lost", loggedAt: outcome.loggedAt }
      : null,
  } as unknown as ProjectedLetterStep;
}

function ev(disputeId: string, kind: string, occurredAt: string): ProjectedHistoryEntry {
  return { kind, actor: "user", occurredAt, disputeId, payload: {}, virtual: false };
}

const CALLS = [
  { kind: "billing_hold_call" as const, calledAt: "2026-06-03T17:00:00.000Z" },
  { kind: "flagged_charges_call" as const, calledAt: "2026-06-12T17:00:00.000Z" },
];

// ── 1. Recipient matching — the false-statement guard ───────────────────────
{
  const history = [
    ev(PROVIDER_LETTER, "letter_sent", "2026-07-01T17:00:00.000Z"),
    ev(INSURER_LETTER, "letter_sent", "2026-07-20T17:00:00.000Z"),
  ];
  const letters = [
    letter(PROVIDER_LETTER, "overcharge", "provider"),
    letter(INSURER_LETTER, "insurance_appeal", "insurer"),
  ];
  const out = buildPriorContactRecital({
    variant: "opening",
    history,
    letters,
    callLog: [],
    recipientKind: "provider",
    letterType: "final_notice",
    excludeDisputeId: FINAL_NOTICE,
  });
  check("recipient · provider letter cites the provider send", out.includes("July 1, 2026"), out);
  check(
    "recipient · provider letter NEVER cites the insurer send as 'I wrote to you'",
    !out.includes("July 20, 2026"),
    out,
  );
}

// ── 2. Unsend netting (§0.9b) — never mailed, never recited ─────────────────
{
  const history = [
    ev(PROVIDER_LETTER, "letter_sent", "2026-07-01T17:00:00.000Z"),
    ev(PROVIDER_LETTER, "letter_unsent", "2026-07-02T17:00:00.000Z"),
    ev(PROVIDER_LETTER, "letter_sent", "2026-07-05T17:00:00.000Z"),
  ];
  const letters = [letter(PROVIDER_LETTER, "overcharge", "provider")];
  const out = buildPriorContactRecital({
    variant: "opening",
    history,
    letters,
    callLog: [],
    recipientKind: "provider",
    letterType: "final_notice",
    excludeDisputeId: FINAL_NOTICE,
  });
  check("unsend · the retracted send is NOT recited", !out.includes("July 1, 2026"), out);
  check("unsend · the genuine resend IS recited", out.includes("July 5, 2026"), out);
  check("unsend · single genuine send collapses to the one-contact form", out.includes("and have not received a resolution."), out);
}

// A send fully retracted with no resend leaves nothing to say.
{
  const history = [
    ev(PROVIDER_LETTER, "letter_sent", "2026-07-01T17:00:00.000Z"),
    ev(PROVIDER_LETTER, "letter_unsent", "2026-07-02T17:00:00.000Z"),
  ];
  const out = buildPriorContactRecital({
    variant: "opening",
    history,
    letters: [letter(PROVIDER_LETTER, "overcharge", "provider")],
    callLog: [],
    recipientKind: "provider",
    letterType: "final_notice",
  });
  check("unsend · fully retracted → empty recital", out === "", out);
}

// ── 3. The composing letter's own draft is excluded ─────────────────────────
{
  const history = [ev(FINAL_NOTICE, "letter_drafted", "2026-08-01T17:00:00.000Z")];
  const out = buildPriorContactRecital({
    variant: "opening",
    history,
    letters: [letter(FINAL_NOTICE, "final_notice", "provider")],
    callLog: [],
    recipientKind: "provider",
    letterType: "final_notice",
    excludeDisputeId: FINAL_NOTICE,
  });
  check("self · a draft is not a contact", out === "", out);
}

// ── 4. Other-track clause — attested conclusions only ───────────────────────
{
  const history = [
    ev(PROVIDER_LETTER, "letter_sent", "2026-07-01T17:00:00.000Z"),
    ev(INSURER_LETTER, "letter_sent", "2026-06-20T17:00:00.000Z"),
  ];
  const base = {
    variant: "opening" as const,
    history,
    callLog: [],
    recipientKind: "provider" as const,
    letterType: "final_notice",
    excludeDisputeId: FINAL_NOTICE,
    includeOtherTrack: true,
  };

  const pending = buildPriorContactRecital({
    ...base,
    letters: [
      letter(PROVIDER_LETTER, "overcharge", "provider"),
      letter(INSURER_LETTER, "insurance_appeal", "insurer"),
    ],
  });
  check(
    "other-track · a PENDING appeal is never mentioned (no 'wait for your appeal')",
    !pending.includes("I also appealed"),
    pending,
  );

  const denied = buildPriorContactRecital({
    ...base,
    letters: [
      letter(PROVIDER_LETTER, "overcharge", "provider"),
      letter(INSURER_LETTER, "insurance_appeal", "insurer", {
        detail: "denied_fully",
        loggedAt: "2026-07-15T17:00:00.000Z",
      }),
    ],
  });
  check(
    "other-track · a LOGGED denial renders with both dates",
    denied.includes("I also appealed to my insurer on June 20, 2026, and that appeal was denied on July 15, 2026."),
    denied,
  );

  const silent = buildPriorContactRecital({
    ...base,
    letters: [
      letter(PROVIDER_LETTER, "overcharge", "provider"),
      letter(INSURER_LETTER, "insurance_appeal", "insurer", {
        detail: "no_response",
        loggedAt: "2026-07-15T17:00:00.000Z",
      }),
    ],
  });
  check(
    "other-track · a LOGGED no-response renders the silence variant",
    silent.includes("I also appealed to my insurer on June 20, 2026 and received no response."),
    silent,
  );

  const partial = buildPriorContactRecital({
    ...base,
    letters: [
      letter(PROVIDER_LETTER, "overcharge", "provider"),
      letter(INSURER_LETTER, "insurance_appeal", "insurer", {
        detail: "needs_info",
        loggedAt: "2026-07-15T17:00:00.000Z",
      }),
    ],
  });
  check("other-track · an OPEN outcome is not a conclusion", !partial.includes("I also appealed"), partial);

  const optedOut = buildPriorContactRecital({
    ...base,
    includeOtherTrack: false,
    letters: [
      letter(PROVIDER_LETTER, "overcharge", "provider"),
      letter(INSURER_LETTER, "insurance_appeal", "insurer", {
        detail: "denied_fully",
        loggedAt: "2026-07-15T17:00:00.000Z",
      }),
    ],
  });
  check("other-track · opt-out suppresses it", !optedOut.includes("I also appealed"), optedOut);
}

// ── 5. Assembly — calls + sends, framing, dedupe ────────────────────────────
{
  const history = [
    ev(PROVIDER_LETTER, "letter_sent", "2026-07-01T17:00:00.000Z"),
    ev(PROVIDER_LETTER, "letter_sent", "2026-07-20T17:00:00.000Z"),
    // Same calendar day as the previous send → one contact, not two.
    ev(PROVIDER_LETTER, "letter_sent", "2026-07-20T23:00:00.000Z"),
  ];
  const out = buildPriorContactRecital({
    variant: "opening",
    history,
    letters: [letter(PROVIDER_LETTER, "overcharge", "provider")],
    callLog: CALLS,
    recipientKind: "provider",
    letterType: "final_notice",
    excludeDisputeId: FINAL_NOTICE,
  });
  check("assembly · opener anchors on the EARLIEST contact", out.startsWith("I have been working to resolve these charges since June 3, 2026."), out);
  check("assembly · call sentences carried verbatim (hold call)", out.includes("I called your billing office and requested a hold on this account — no further billing or collection activity — while this claim is reviewed."), out);
  check("assembly · call sentences carried verbatim (flagged charges)", out.includes("I called your billing office and disputed specific charges on this account."), out);
  check("assembly · sends joined with an Oxford 'and'", out.includes("I wrote to you on July 1, 2026 and July 20, 2026."), out);
  check("assembly · same-day sends dedupe to one date", out.split("July 20, 2026").length - 1 === 1, out);
  check("assembly · closer", out.endsWith("None of these attempts has produced a resolution."), out);
  check("assembly · notes NEVER rendered", !out.includes("ref"), out);
}

// Three or more dates use commas + a terminal "and".
{
  const history = [
    ev(PROVIDER_LETTER, "letter_sent", "2026-07-01T17:00:00.000Z"),
    ev(PROVIDER_LETTER, "letter_sent", "2026-07-10T17:00:00.000Z"),
    ev(PROVIDER_LETTER, "letter_sent", "2026-07-20T17:00:00.000Z"),
  ];
  const out = buildPriorContactRecital({
    variant: "opening",
    history,
    letters: [letter(PROVIDER_LETTER, "overcharge", "provider")],
    callLog: [],
    recipientKind: "provider",
    letterType: "final_notice",
  });
  check("assembly · three dates → Oxford list", out.includes("July 1, 2026, July 10, 2026, and July 20, 2026"), out);
}

// One call only → the rich sentence is kept, with a singular closer.
{
  const out = buildPriorContactRecital({
    variant: "opening",
    history: [],
    letters: [],
    callLog: [CALLS[0]],
    recipientKind: "provider",
    letterType: "final_notice",
  });
  check("assembly · single call keeps the RICH sentence", out.includes("requested a hold on this account"), out);
  check("assembly · single call gets the singular closer", out.endsWith("That call has not produced a resolution."), out);
  check("assembly · single contact has no opener", !out.includes("I have been working to resolve"), out);
}

// ── 6. Exclusions ──────────────────────────────────────────────────────────
{
  const args = {
    variant: "opening" as const,
    history: [ev(PROVIDER_LETTER, "letter_sent", "2026-07-01T17:00:00.000Z")],
    letters: [letter(PROVIDER_LETTER, "overcharge", "provider")],
    callLog: CALLS,
    recipientKind: "provider" as const,
  };
  check("exclusions · itemized_request → empty", buildPriorContactRecital({ ...args, letterType: "itemized_request" }) === "");
  check("exclusions · negotiation → empty", buildPriorContactRecital({ ...args, letterType: "negotiation" }) === "");
  check(
    "exclusions · collector recipient → empty",
    buildPriorContactRecital({ ...args, recipientKind: "collector", letterType: "debt_validation" }) === "",
  );
  check(
    "exclusions · no timeline (flag OFF) + no calls → empty",
    buildPriorContactRecital({
      variant: "opening",
      history: null,
      letters: null,
      callLog: [],
      recipientKind: "provider",
      letterType: "final_notice",
    }) === "",
  );
}

// ── 7. signoff variant == the absorbed S297 recital ─────────────────────────
{
  const out = buildPriorContactRecital({
    variant: "signoff",
    history: [ev(PROVIDER_LETTER, "letter_sent", "2026-07-01T17:00:00.000Z")],
    letters: [letter(PROVIDER_LETTER, "overcharge", "provider")],
    callLog: CALLS,
    recipientKind: "provider",
    letterType: "overcharge",
  });
  check("signoff · calls only — no sends", !out.includes("I wrote to you"), out);
  check("signoff · no framing (byte-identical to S297)", !out.includes("I have been working") && !out.includes("None of these attempts"), out);
  check("signoff · both call sentences present, space-joined", out.includes("requested a hold") && out.includes("disputed specific charges"), out);
  check(
    "signoff · insurer letter takes only the insurer call",
    buildPriorContactRecital({
      variant: "signoff",
      history: null,
      letters: null,
      callLog: [{ kind: "insurer_call", calledAt: "2026-06-03T17:00:00.000Z" }],
      recipientKind: "insurer",
      letterType: "insurance_appeal",
    }).includes("member services"),
  );
  check(
    "signoff · provider-side calls never appear on an insurer letter",
    !buildPriorContactRecital({
      variant: "signoff",
      history: null,
      letters: null,
      callLog: CALLS,
      recipientKind: "insurer",
      letterType: "insurance_appeal",
    }).includes("billing office"),
  );
}

console.log(`\nprior-contact fixture: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  console.log("FAILED ✗");
  process.exit(1);
}
console.log("ALL GREEN ✓");
