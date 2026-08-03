/**
 * guided-steps/registry — Guided Steps v1 (S297) registry contract fixture.
 *
 * Locks the handoff §8 invariants:
 *   1. Step ids: KEY_RE-valid, unique across packs, STABLE (exact-set lock —
 *      renaming an id orphans persisted check-offs in claims/dispute metadata).
 *   2. Every checkbox step has a checkboxLabel; every step a non-empty title.
 *   3. Attest-only lint: no rendered string may promise Candid action
 *      ("Candid will", "we will", "automatically", "we'll follow") — the
 *      "Done does nothing" defect family (S294/S295) kept out by construction.
 *   4. Autofill honesty: FULL context renders with real values and no
 *      placeholder holes (« », [account, undefined, NaN); EMPTY context takes
 *      the prep-chip path (null script) or a hole-free degrade — never prose
 *      with gaps.
 *   5. Finding→clause composer: duplicate + unbundling + cap-at-3 + "And N
 *      more" tail + zero-findings degrade (never "0 charges").
 *   6. suggestDoors: all four branches + the max-2 cap.
 *   7. KEY_RE sync: the registry regex matches BOTH checklist routes' literal
 *      KEY_RE source, and both routes carry the note extension (max-500 cap)
 *      + the foreign-row 404 anti-enum path.
 *
 * Run:  npx tsx scripts/calibration/fixtures/guided-steps/registry.ts
 * CI:   .github/workflows/ci.yml (Guided Steps v1).
 */
import { resolve } from "path";
import { readFileSync } from "fs";
import {
  ALL_GUIDE_STEPS,
  GUIDE_4B,
  GUIDE_KEY_RE,
  PHONE_OUTCOME,
  PACK_A_INSURER_STEPS,
  PACK_A_PROVIDER_STEPS,
  PACK_C_STEPS,
  PACK_D_STEPS,
  composeFindingClauses,
  countCheckboxSteps,
  guidedCallLogFromMeta,
  isTerminalRung,
  packCDeadlineSentence,
  packCFirstContactCopy,
  suggestDoors,
  type GuideFillContext,
  type GuideFinding,
  type ScriptSegment,
} from "../../../../src/lib/guides/pack-registry";
import { buildPriorContactRecital } from "../../../../src/lib/disputes/prior-contact";
import type { GuidedCallLogEntry } from "../../../../src/lib/guides/pack-registry";

/**
 * S300 — the S297 call recital was absorbed into the ONE prior-contact builder
 * (tracker Item N). Its `signoff` variant IS the old function: calls only, no
 * framing, same recipient-matching and letter-type exclusions. These
 * assertions are kept verbatim through this shim so the consolidation is
 * proven behavior-preserving rather than asserted to be. The `opening`
 * variant (calls + sends + other-track) is covered by the prior-contact
 * fixture.
 */
const renderGuidedCallRecital = (
  entries: GuidedCallLogEntry[] | null | undefined,
  recipient: "insurer" | "provider" | "collector",
  letterType: string,
): string =>
  buildPriorContactRecital({
    variant: "signoff",
    history: null,
    letters: null,
    callLog: entries,
    recipientKind: recipient,
    letterType,
  });

let pass = 0;
const fails: string[] = [];
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    pass += 1;
  } else {
    fails.push(`${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const text = (segs: ScriptSegment[] | null): string =>
  segs == null ? "" : segs.map((s) => s.text).join("");

// ── Contexts ────────────────────────────────────────────────────────────────

const DUP: GuideFinding = {
  type: "duplicate",
  lineNumber: 4,
  dateLabel: "March 3",
  serviceNoun: "blood count",
  parentLabel: null,
};
const UNB: GuideFinding = {
  type: "unbundling",
  lineNumber: 6,
  dateLabel: "March 3",
  serviceNoun: "surgical tray",
  parentLabel: "operating room fee",
};

const FULL: GuideFillContext = {
  track: "insurer",
  serviceLabel: "OFFICE/OUTPATIENT VISIT EST",
  dosLong: "April 25, 2024",
  providerName: "SWEDISH PRIMARY CARE BALLARD",
  billedAmount: 221,
  planVerdictLabel: "covered with 0% coinsurance",
  insurerPaid: 0,
  patientPaid: 150,
  accountNumber: "48812-A",
  claimNumber: "CLM-0042",
  memberIdOnFile: true,
  planNameOnFile: true,
  providerPhone: "1-800-555-0000",
  memberServicesPhone: "1-800-555-0134",
  findings: [DUP, UNB],
  flaggedCount: 2,
  flaggedTotal: 412,
};

const EMPTY: GuideFillContext = {
  track: "provider",
  serviceLabel: null,
  dosLong: null,
  providerName: null,
  billedAmount: null,
  planVerdictLabel: null,
  insurerPaid: null,
  patientPaid: null,
  accountNumber: null,
  claimNumber: null,
  memberIdOnFile: false,
  planNameOnFile: false,
  providerPhone: null,
  memberServicesPhone: null,
  findings: [],
  flaggedCount: 0,
  flaggedTotal: null,
};

// ── 1. Step ids: KEY_RE, uniqueness, stability ─────────────────────────────

const EXPECTED_IDS = [
  "packA:ins-call-insurer",
  "packA:ins-ask-hold",
  "packA:ins-handoff",
  "packA:prov-itemized",
  "packA:prov-call-flagged",
  "packA:prov-log-call",
  "packA:prov-ask-hold",
  "packA:prov-handoff",
  "packC:not-paid",
  "packC:first-contact",
  "packC:mailed",
  "packC:receipt",
  "packC:outcome",
  "packD:docs-ready",
  "packD:filed",
  "packD:outcome",
];
const ids = ALL_GUIDE_STEPS.map((s) => s.id);
check("ids: stable exact set", JSON.stringify(ids) === JSON.stringify(EXPECTED_IDS),
  `got ${JSON.stringify(ids)}`);
check("ids: unique", new Set(ids).size === ids.length);
for (const id of ids) check(`ids: KEY_RE ${id}`, GUIDE_KEY_RE.test(id));

// ── 2. Structural completeness ──────────────────────────────────────────────

for (const s of ALL_GUIDE_STEPS) {
  check(`title non-empty: ${s.id}`, s.title.trim().length > 0);
  if (s.control === "checkbox") {
    check(`checkboxLabel present: ${s.id}`, (s.checkboxLabel ?? "").trim().length > 0);
  }
}

// ── 3 + 4. Rendered-output sweep: attest-only lint + no holes ──────────────

const BANNED = [/candid will/i, /\bwe will\b/i, /automatically/i, /we'll follow/i];
const HOLES = [/«/, /»/, /\[account/i, /undefined/, /NaN/];

function sweep(label: string, s: string) {
  for (const re of BANNED) check(`attest-only [${label}]`, !re.test(s), `matched ${re} in "${s.slice(0, 80)}"`);
  for (const re of HOLES) check(`no-hole [${label}]`, !re.test(s), `matched ${re} in "${s.slice(0, 80)}"`);
}

for (const ctx of [FULL, EMPTY]) {
  const which = ctx === FULL ? "full" : "empty";
  for (const s of ALL_GUIDE_STEPS) {
    sweep(`${s.id}.title`, s.title);
    if (s.checkboxLabel) sweep(`${s.id}.checkbox`, s.checkboxLabel);
    const copy = typeof s.copy === "string" ? [{ text: s.copy }] : s.copy(ctx);
    if (copy) sweep(`${s.id}.copy(${which})`, text(copy));
    if (s.script) {
      const segs = s.script(ctx);
      if (segs) sweep(`${s.id}.script(${which})`, text(segs));
    }
    if (s.underScript) sweep(`${s.id}.underScript`, s.underScript);
    if (s.note) sweep(`${s.id}.note`, s.note.placeholder);
    if (s.cta) sweep(`${s.id}.cta`, s.cta.label);
  }
}

// ── 4b. Fill correctness + degrade paths ───────────────────────────────────

const insurerScript = PACK_A_INSURER_STEPS[0].script!;
const fullInsurer = text(insurerScript(FULL));
check("insurer script: lowercased service", fullInsurer.includes("office/outpatient visit est"));
check("insurer script: billed", fullInsurer.includes("$221.00"));
check("insurer script: insurer paid $0.00 (0 is a real value)", fullInsurer.includes("plan paid $0.00"));
check("insurer script: patient paid", fullInsurer.includes("$150.00"));
check("insurer script: verdict", fullInsurer.includes("covered with 0% coinsurance"));
check("insurer script: EMPTY → null (prep-chip path)", insurerScript(EMPTY) == null);

const holdScript = PACK_A_INSURER_STEPS[1].script!;
check("hold script: EMPTY → null", holdScript(EMPTY) == null);
check("hold script: FULL renders dos", text(holdScript(FULL)).includes("April 25, 2024"));

const itemized = PACK_A_PROVIDER_STEPS[0].script!;
check("itemized script: FULL uses account #", text(itemized(FULL)).includes("account #48812-A"));
check("itemized script: EMPTY degrades to 'my account'", text(itemized(EMPTY)).includes("my account"));

const flaggedCopy = PACK_A_PROVIDER_STEPS[1].copy as (c: GuideFillContext) => ScriptSegment[];
check("flagged copy: N + $", text(flaggedCopy(FULL)).includes("2 charges worth $412.00"));
check(
  "flagged copy: singular",
  text(flaggedCopy({ ...FULL, flaggedCount: 1, findings: [DUP], flaggedTotal: 88 })).includes(
    "1 charge worth $88.00",
  ),
);
const zeroCopy = text(flaggedCopy({ ...FULL, flaggedCount: 0, findings: [], flaggedTotal: null }));
check("flagged copy: zero-findings degrade, no zero", !zeroCopy.includes("0 charge") && zeroCopy.includes("verify the balance"));

const flaggedScript = PACK_A_PROVIDER_STEPS[1].script!;
const zeroScript = text(flaggedScript({ ...FULL, findings: [] }));
check("flagged script: zero-findings → verify-the-balance ask", zeroScript.includes("verify the balance"));
check("flagged script: FULL carries the duplicate clause", text(flaggedScript(FULL)).includes("appears to be a duplicate"));

const handoffCopy = PACK_A_PROVIDER_STEPS[4].copy as (c: GuideFillContext) => ScriptSegment[];
check("handoff copy: real count", text(handoffCopy(FULL)).includes("2 flagged charges"));
check("handoff copy: zero-findings drops the count clause", !text(handoffCopy({ ...FULL, flaggedCount: 0, findings: [] })).match(/\d+ flagged/));

// ── 5. Clause composer ──────────────────────────────────────────────────────

check("composer: duplicate clause", text(composeFindingClauses([DUP])).includes("Line 4, dated March 3, appears to be a duplicate — the same blood count is charged twice."));
check("composer: unbundling clause", text(composeFindingClauses([UNB])).includes("billed alongside the operating room fee that already includes it"));
const many = composeFindingClauses([DUP, DUP, DUP, DUP, DUP]);
check("composer: cap at 3 + tail", text(many).includes("And 2 more on the corrected-bill review."));
check("composer: zero → []", composeFindingClauses([]).length === 0);
check(
  "composer: incomplete finding skipped (no holes)",
  composeFindingClauses([{ type: "duplicate", lineNumber: null, dateLabel: null, serviceNoun: null, parentLabel: null }]).length === 0,
);
check(
  "composer: unmapped type emits nothing",
  composeFindingClauses([{ type: "overcharge", lineNumber: 1, dateLabel: "May 1", serviceNoun: "x-ray", parentLabel: null }]).length === 0,
);

// ── 6. suggestDoors ─────────────────────────────────────────────────────────

check("doors: provider → ag", JSON.stringify(suggestDoors({ track: "provider", hasCollections: false, grounds: [] })) === '["ag"]');
check("doors: insurer → doi", JSON.stringify(suggestDoors({ track: "insurer", hasCollections: false, grounds: [] })) === '["doi"]');
check("doors: +cfpb on collections", JSON.stringify(suggestDoors({ track: "provider", hasCollections: true, grounds: [] })) === '["ag","cfpb"]');
check("doors: +cms on balance_billing", JSON.stringify(suggestDoors({ track: "insurer", hasCollections: false, grounds: ["balance_billing"] })) === '["doi","cms"]');
check("doors: cap 2", suggestDoors({ track: "provider", hasCollections: true, grounds: ["balance_billing"] }).length === 2);

// ── 6b. Terminal-rung predicate ─────────────────────────────────────────────

check("terminal: external_review", isTerminalRung({ letterType: "external_review", status: null }));
check("terminal: final_notice", isTerminalRung({ letterType: "final_notice", status: "sent" }));
check("terminal: lost", isTerminalRung({ letterType: "insurance_appeal", status: "lost" }));
check("terminal: NOT mid-ladder", !isTerminalRung({ letterType: "insurance_appeal", status: "sent" }));
check("terminal: NOT on win", !isTerminalRung({ letterType: "overcharge", status: "won" }));

// ── Pack C helpers ──────────────────────────────────────────────────────────

const cCtx = { collectorName: "ABC Recovery", firstContactDateLabel: "Jul 12, 2026", validationDeadlineLabel: "Aug 11, 2026" };
check("packC derived copy renders date", text(packCFirstContactCopy(cCtx)).includes("Jul 12, 2026, from your case details."));
check("packC derived copy: absent date → null", packCFirstContactCopy({ ...cCtx, firstContactDateLabel: null }) == null);
check("packC deadline sentence", text(packCDeadlineSentence(cCtx)).includes("Strongest if sent by Aug 11, 2026 — 30 days from first contact, FDCPA §1692g."));
check("packC deadline sentence: absent → null", packCDeadlineSentence({ ...cCtx, validationDeadlineLabel: null }) == null);

// ── Checkbox counts (the "N of M" denominators) ────────────────────────────

check("counts: insurer A′ = 2", countCheckboxSteps(PACK_A_INSURER_STEPS) === 2);
check("counts: provider A′ = 3", countCheckboxSteps(PACK_A_PROVIDER_STEPS) === 3);
check("counts: pack C = 3", countCheckboxSteps(PACK_C_STEPS) === 3);
check("counts: pack D = 2", countCheckboxSteps(PACK_D_STEPS) === 2);

// ── 7. Route sync: KEY_RE + note extension + anti-enum 404 ─────────────────

const repoRoot = resolve(__dirname, "../../../..");
const claimRoute = readFileSync(
  resolve(repoRoot, "src/app/api/claims/[claimId]/checklist/route.ts"),
  "utf8",
);
const disputeRoute = readFileSync(
  resolve(repoRoot, "src/app/api/disputes/[disputeId]/checklist/route.ts"),
  "utf8",
);
const KEY_RE_SRC = "/^[a-zA-Z0-9_.:-]{1,64}$/";
check("route sync: registry KEY_RE literal", GUIDE_KEY_RE.source === "^[a-zA-Z0-9_.:-]{1,64}$");
check("route sync: claims route KEY_RE", claimRoute.includes(KEY_RE_SRC));
check("route sync: dispute route KEY_RE", disputeRoute.includes(KEY_RE_SRC));
check("route sync: claims note cap", claimRoute.includes("NOTE_MAX = 500"));
check("route sync: dispute note cap", disputeRoute.includes("note exceeds 500 characters"));
check("route sync: dispute checklistNotes storage", disputeRoute.includes("checklistNotes"));
check("route sync: claims guideSteps storage", claimRoute.includes("guideSteps"));
check("route sync: claims foreign → 404", claimRoute.includes('{ error: "Claim not found" }, { status: 404 }'));
check("route sync: dispute foreign → 404", disputeRoute.includes('{ error: "Dispute not found" }, { status: 404 }'));
check("route sync: claims server-side timestamp", claimRoute.includes("new Date().toISOString()"));
// S297 excerpt-contradiction guard — a covered-service bullet must never
// quote plan language carrying a negation (the SBC whole-row-excerpt case);
// the quote TRUNCATES at the negation with an ellipsis (CF-60: verbatim
// prefix, no altered words) and omits entirely when nothing quotable is left.
const templatesSrc = readFileSync(resolve(repoRoot, "src/lib/disputes/templates.ts"), "utf8");
check("templates: truncating excerpt guard present", templatesSrc.includes("quotableExcerpt"));
check(
  "templates: guard covers the not-covered negation",
  /quotableExcerpt[\s\S]{0,600}not\\s\+covered/.test(templatesSrc),
);
check("templates: truncation marks the cut with an ellipsis", templatesSrc.includes("} …`"));

// S297 noteHistory — accidental note deletes must be recoverable on BOTH routes.
check("route sync: claims noteHistory banked", claimRoute.includes("noteHistory"));
check("route sync: claims noteHistory capped", claimRoute.includes(".slice(-5)"));
check("route sync: dispute noteHistory banked", disputeRoute.includes("checklistNoteHistory"));
check("route sync: dispute noteHistory capped", disputeRoute.includes(".slice(-5)"));

// ── 7b. Phone-outcome question (S297) ──────────────────────────────────────

check("phone-outcome: id KEY_RE", GUIDE_KEY_RE.test(PHONE_OUTCOME.id));
check("phone-outcome: id not colliding with steps", !EXPECTED_IDS.includes(PHONE_OUTCOME.id));
for (const [k, v] of Object.entries(PHONE_OUTCOME)) {
  if (k === "id") continue;
  sweep(`phone-outcome.${k}`, v);
}
for (const [k, v] of Object.entries(GUIDE_4B)) {
  sweep(`guide-4b.${k}`, v);
}

// ── 8. Call-log → letter recital (S297) ────────────────────────────────────

const META = {
  "packA:ins-call-insurer": { checkedAt: "2026-07-30T14:10:00Z", note: "Maria · ref 8812 · will reprocess" },
  "packA:ins-ask-hold": { checkedAt: "2026-07-30T14:20:00Z" },
  "packA:prov-ask-hold": { checkedAt: "2026-07-30T15:00:00Z" },
  "packA:prov-itemized": { checkedAt: null },
  "packC:not-paid": { checkedAt: "2026-07-30T16:00:00Z" },
};
const logEntries = guidedCallLogFromMeta(META);
check("callLog: attested-only + no packC leak", logEntries.length === 2, JSON.stringify(logEntries));
check("callLog: insurer call present", logEntries.some((e) => e.kind === "insurer_call"));
check("callLog: hold deduped to earliest", logEntries.filter((e) => e.kind === "billing_hold_call").length === 1 && logEntries.find((e) => e.kind === "billing_hold_call")?.calledAt === "2026-07-30T14:20:00Z");
check("callLog: note carried (not rendered)", logEntries.find((e) => e.kind === "insurer_call")?.note === "Maria · ref 8812 · will reprocess");
check("callLog: chronological", logEntries[0].kind === "insurer_call");
check("callLog: null meta → []", guidedCallLogFromMeta(null).length === 0);
check("callLog: unattested-only → []", guidedCallLogFromMeta({ "packA:prov-itemized": { checkedAt: null, note: "x" } }).length === 0);

const insurerRecital = renderGuidedCallRecital(logEntries, "insurer", "insurance_appeal");
check("recital: insurer letter cites the member-services call", insurerRecital.includes("I called your member services line about this claim and asked that it be reviewed and reprocessed."));
check("recital: insurer letter omits provider-side calls", !insurerRecital.includes("billing office"));
check("recital: note NEVER rendered", !insurerRecital.includes("Maria") && !insurerRecital.includes("8812"));
const providerRecital = renderGuidedCallRecital(logEntries, "provider", "overcharge");
check("recital: provider letter cites the hold call", providerRecital.includes("requested a hold on this account — no further billing or collection activity"));
check("recital: provider letter omits the insurer call", !providerRecital.includes("member services"));
check("recital: collector → empty", renderGuidedCallRecital(logEntries, "collector", "debt_validation") === "");
check("recital: excluded letter types → empty", renderGuidedCallRecital(logEntries, "provider", "itemized_request") === "" && renderGuidedCallRecital(logEntries, "provider", "negotiation") === "");
check("recital: empty entries → empty", renderGuidedCallRecital([], "provider", "overcharge") === "");
check("recital: no matching kinds → empty", renderGuidedCallRecital([{ kind: "insurer_call", calledAt: "2026-07-30T14:10:00Z" }], "provider", "overcharge") === "");
sweep("recital.insurer", insurerRecital);
sweep("recital.provider", providerRecital);
const allKinds = guidedCallLogFromMeta({
  "packA:ins-call-insurer": { checkedAt: "2026-07-30T10:00:00Z" },
  "packA:prov-itemized": { checkedAt: "2026-07-30T11:00:00Z" },
  "packA:prov-call-flagged": { checkedAt: "2026-07-30T12:00:00Z" },
  "packA:prov-ask-hold": { checkedAt: "2026-07-30T13:00:00Z" },
});
const fullProvider = renderGuidedCallRecital(allKinds, "provider", "final_notice");
check("recital: itemized + flagged + hold all render on provider letters",
  fullProvider.includes("fully itemized bill") && fullProvider.includes("disputed specific charges") && fullProvider.includes("requested a hold"));
sweep("recital.fullProvider", fullProvider);

// ── Report ──────────────────────────────────────────────────────────────────

if (fails.length > 0) {
  console.error(`\n✗ guided-steps registry fixture — ${fails.length} FAILED (of ${pass + fails.length}):`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ guided-steps registry fixture — ${pass} checks passed`);
