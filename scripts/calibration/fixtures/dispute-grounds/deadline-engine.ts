/**
 * deadline-engine — dispute-letters v2 S4 (map §3) unit fixture.
 *
 * Proves the pure deadline logic on deterministic synthetic inputs (fixed clock):
 *   - per-track compute (fdcpa from contact date · plan_response from generation date ·
 *     provider → null · INERT state → null),
 *   - the guard (ok | urgent | past) incl. erisa-past → external-review next step and
 *     fdcpa-past → debtWithinWindow=false (unifying the S2 route check),
 *   - UTC boundary exactness (no off-by-one; a time component doesn't shift the day),
 *   - config merge — defaults, per-key override wins, malformed keys fall back.
 *
 * Run:  npx tsx scripts/calibration/fixtures/dispute-grounds/deadline-engine.ts
 */
import {
  evaluateDeadline,
  mergeDeadlineConfig,
  computeFollowupSchedule,
  DEADLINE_DEFAULTS,
  type DeadlineResult,
  type DeadlineType,
  type DeadlineSeverity,
} from "../../../../src/lib/disputes/deadline-engine";
import { buildFollowupLetter } from "../../../../src/lib/disputes/followup-letter";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}${got !== undefined ? `  (${String(got)})` : ""}`);
}

const NOW = new Date("2026-07-02T00:00:00Z");
const DAY = 86400000;
/** YYYY-MM-DD offset from NOW (used only for INPUTS, so no self-referential date math). */
function iso(offsetDays: number): string {
  return new Date(NOW.getTime() + offsetDays * DAY).toISOString().split("T")[0];
}
const CFG = mergeDeadlineConfig({}); // statutory defaults

interface Expect {
  gov?: string | null;
  type?: DeadlineType | null;
  sev?: DeadlineSeverity;
  within?: boolean;
  days?: number | null;
  nextStep?: "some" | "none";
}
function expect(label: string, r: DeadlineResult, exp: Expect): void {
  if ("gov" in exp) check(`${label} · gov`, r.governingDeadlineDate === exp.gov, r.governingDeadlineDate);
  if ("type" in exp) check(`${label} · type`, r.deadlineType === exp.type, r.deadlineType);
  if ("sev" in exp) check(`${label} · severity`, r.guard.severity === exp.sev, r.guard.severity);
  if ("within" in exp) check(`${label} · within`, r.debtWithinWindow === exp.within, r.debtWithinWindow);
  if ("days" in exp) check(`${label} · days`, r.guard.daysRemaining === exp.days, r.guard.daysRemaining);
  if ("nextStep" in exp)
    check(`${label} · nextStep`, exp.nextStep === "some" ? !!r.guard.nextStep : !r.guard.nextStep, r.guard.nextStep);
}
const ev = (letterType: string, extra: Record<string, unknown> = {}): DeadlineResult =>
  evaluateDeadline({ letterType, now: NOW, ...extra }, CFG);

// ── Collector track (FDCPA §1692g) — expected dates hand-computed (anchor + 30) ──
expect("fdcpa in-window (contact −10d)", ev("debt_validation", { collectorFirstContactDate: iso(-10) }), {
  gov: "2026-07-22", type: "fdcpa_validation_30", sev: "ok", within: true, days: 20,
});
expect("fdcpa urgent (contact −25d)", ev("debt_validation", { collectorFirstContactDate: iso(-25) }), {
  gov: "2026-07-07", sev: "urgent", within: true, days: 5,
});
expect("fdcpa past (contact −40d)", ev("debt_validation", { collectorFirstContactDate: iso(-40) }), {
  gov: "2026-06-22", sev: "past", within: false, days: -10, nextStep: "some",
});
expect("fdcpa boundary (contact −30d = last day)", ev("debt_validation", { collectorFirstContactDate: iso(-30) }), {
  gov: "2026-07-02", sev: "urgent", within: true, days: 0,
});
expect("fdcpa no anchor → fail-closed", ev("debt_validation", { collectorFirstContactDate: null }), {
  gov: null, type: null, sev: "ok", within: false,
});
// UTC exactness: a time component must not shift the day.
expect("fdcpa UTC (contact −10d w/ time)", ev("debt_validation", { collectorFirstContactDate: "2026-06-22T23:30:00Z" }), {
  gov: "2026-07-22", days: 20,
});

// ── Insurer track (plan_response clock + ERISA guard) — plan_response gov hand-computed (now + 60) ──
expect("appeal, no denial date → guard dormant", ev("insurance_appeal", { denialNoticeDate: null }), {
  gov: "2026-08-31", type: "plan_response", sev: "ok", within: false,
});
expect("appeal, denial −200d → erisa PAST, deadline suppressed", ev("insurance_appeal", { denialNoticeDate: iso(-200) }), {
  gov: null, type: null, sev: "past", days: -20, nextStep: "some",
});
expect("appeal, denial −175d → erisa urgent, still files", ev("insurance_appeal", { denialNoticeDate: iso(-175) }), {
  gov: "2026-08-31", type: "plan_response", sev: "urgent", days: 5,
});
expect("appeal, pre-service → 30d plan_response", ev("insurance_appeal", { isPreService: true }), {
  gov: "2026-08-01", type: "plan_response",
});
// external_review (I2) is the escalation TARGET, not a plan_response-tracked letter → null.
expect("external_review → null (not plan_response-tracked)", ev("external_review", { denialNoticeDate: iso(-30) }), {
  gov: null, type: null, sev: "ok", within: false,
});

// ── Provider track + INERT — no governing deadline at launch ──
for (const lt of ["overcharge", "duplicate_charge", "balance_billing", "itemized_request", "final_notice", "negotiation"]) {
  expect(`provider ${lt} → null`, ev(lt, { collectorFirstContactDate: iso(-5), denialNoticeDate: iso(-5) }), {
    gov: null, type: null, sev: "ok", within: false,
  });
}

// ── Config: defaults, override-wins, malformed-fallback ──
check("defaults · buffer 10", CFG.bufferDays === 10, CFG.bufferDays);
check("defaults · erisa 180", CFG.windowDays.erisa_appeal_180 === 180, CFG.windowDays.erisa_appeal_180);
check("defaults · fractions [.33,.66]", JSON.stringify(CFG.followUpFractions) === "[0.33,0.66]", CFG.followUpFractions);

const cfgBuf30 = mergeDeadlineConfig({ deadline_buffer_days: 30 });
// contact −5d → 25 days remaining: ok under default buffer 10, urgent once buffer ≥ 25.
expect(
  "override buffer 30 flips ok→urgent",
  evaluateDeadline({ letterType: "debt_validation", collectorFirstContactDate: iso(-5), now: NOW }, cfgBuf30),
  { sev: "urgent", days: 25 },
);

const cfgFdcpa45 = mergeDeadlineConfig({ deadline_window_days: { fdcpa_validation_30: 45 } });
// contact −40d → past under 30, in-window (5 left) under 45. Per-track override + tunability.
expect(
  "per-track window override (fdcpa 45)",
  evaluateDeadline({ letterType: "debt_validation", collectorFirstContactDate: iso(-40), now: NOW }, cfgFdcpa45),
  { gov: "2026-07-07", sev: "urgent", within: true, days: 5 },
);

const cfgGarbage = mergeDeadlineConfig({
  deadline_buffer_days: "x",
  deadline_window_days: { fdcpa_validation_30: -5, plan_response: 0 },
  follow_up_fractions: "nope",
});
check("garbage buffer → 10", cfgGarbage.bufferDays === 10, cfgGarbage.bufferDays);
check("garbage fdcpa (−5) → 30", cfgGarbage.windowDays.fdcpa_validation_30 === 30, cfgGarbage.windowDays.fdcpa_validation_30);
check("garbage plan_response (0) → 60", cfgGarbage.windowDays.plan_response === 60, cfgGarbage.windowDays.plan_response);
check("garbage fractions → default", JSON.stringify(cfgGarbage.followUpFractions) === "[0.33,0.66]", cfgGarbage.followUpFractions);

const cfgFrac = mergeDeadlineConfig({ follow_up_fractions: [0.25, 0.5, 0.75] });
check("valid fractions override", JSON.stringify(cfgFrac.followUpFractions) === "[0.25,0.5,0.75]", cfgFrac.followUpFractions);

// DEADLINE_DEFAULTS is the fallback source of truth.
check("DEADLINE_DEFAULTS buffer 10", DEADLINE_DEFAULTS.bufferDays === 10, DEADLINE_DEFAULTS.bufferDays);

// ── Graduated follow-up schedule (⅓ / ⅔ / final = deadline − buffer) ──
function checkSchedule(label: string, dl: string, expected: [string, string][]): void {
  const sched = computeFollowupSchedule(dl, CFG, NOW);
  check(`${label} · len ${expected.length}`, sched.length === expected.length, JSON.stringify(sched));
  expected.forEach(([date, kind], i) => {
    check(`${label} · [${i}] ${date}/${kind}`, sched[i]?.dueDate === date && sched[i]?.kind === kind, JSON.stringify(sched[i]));
  });
}
// plan_response 60d window (deadline NOW+60): ⅓→+20, ⅔→+40, final→deadline−10.
checkSchedule("schedule 60d", "2026-08-31", [
  ["2026-07-22", "deadline_interim"],
  ["2026-08-11", "deadline_interim"],
  ["2026-08-21", "deadline_final"],
]);
// fdcpa 20d remaining (deadline NOW+20): ⅓→+7, final→+10; the ⅔ point (+13) is past the final → dropped.
checkSchedule("schedule 20d (⅔ past final → dropped)", "2026-07-22", [
  ["2026-07-09", "deadline_interim"],
  ["2026-07-12", "deadline_final"],
]);
// 5d window: buffer (10) exceeds window → no final; interims still run up to the deadline.
checkSchedule("schedule 5d (buffer>window → interims only)", "2026-07-07", [
  ["2026-07-04", "deadline_interim"],
  ["2026-07-05", "deadline_interim"],
]);
checkSchedule("schedule deadline today → none", iso(0), []);
checkSchedule("schedule deadline past → none", iso(-10), []);

// ── Follow-up letter render (fail-closed, no placeholder, framework-anchored) ──
const PLACEHOLDER = /\$\[|\[[A-Za-z]/;
const apLetter = buildFollowupLetter({
  recipientKind: "insurer", parentLetterType: "insurance_appeal", parentSentDate: "2026-07-02",
  governingDeadlineDate: "2026-08-31", deadlineType: "plan_response", isFinal: false, now: NOW,
});
check("followup letter (appeal) · Appeals Department", apLetter.includes("Appeals Department"));
check("followup letter (appeal) · references internal appeal", apLetter.includes("internal appeal"));
check("followup letter (appeal) · deadline date rendered", apLetter.includes("August 31, 2026"));
check("followup letter (appeal) · disclaimer", apLetter.includes("not a law firm"));
check("followup letter (appeal) · no placeholder", !PLACEHOLDER.test(apLetter), PLACEHOLDER.exec(apLetter)?.[0]);

const dvLetter = buildFollowupLetter({
  recipientKind: "collector", parentLetterType: "debt_validation", parentSentDate: "2026-07-02",
  governingDeadlineDate: "2026-07-22", deadlineType: "fdcpa_validation_30", isFinal: true, now: NOW,
});
check("followup letter (debt, final) · Collections Department", dvLetter.includes("Collections Department"));
check("followup letter (debt, final) · final follow-up wording", dvLetter.includes("final follow-up"));
check("followup letter (debt, final) · FDCPA clause", dvLetter.includes("Fair Debt Collection Practices Act"));
check("followup letter (debt, final) · no placeholder", !PLACEHOLDER.test(dvLetter), PLACEHOLDER.exec(dvLetter)?.[0]);

console.log(`\ndeadline-engine fixture: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.error(fails.join("\n"));
  process.exit(1);
}
console.log("ALL GREEN ✓");
