/**
 * intake-gates — Gates 0–6 (legal review §5 Path A) + the R18 runway, PURE.
 *
 * "The legal front door." Candid may only take matters that need pure
 * EXECUTION (paperwork, submission, deadlines) — never matters that would
 * require judgment about what to argue, and never coverage types the law walls
 * off. FAIL-CLOSED: every gate must pass; an unknown answer is a decline.
 * Declined applicants keep the entire free tool.
 *
 * The facts come from what the platform already stores (the member's plan-level
 * screening answers, the litigation attestation, the collections fact, the
 * composition events, the deadline engine) plus three operator-attested
 * intake answers read off the member's own documents. Nothing here reads a
 * database — the route assembles the facts and this module decides.
 */
import type { RegulatoryClassification } from "@/lib/disputes/forums";
import { dfyLaneOpen } from "./state-lanes";

export type PlanSponsorType =
  | "single_employer"
  | "mewa_association_peo"
  | "individual_marketplace"
  | "unknown";

export interface IntakeFacts {
  /** profiles.state at intake. */
  memberState: string | null;
  /** insurance_plans.metadata.regulatory_classification (S325 screening). */
  classification: RegulatoryClassification | null;
  /** Operator-attested from the plan documents. null = not yet answered. */
  planSponsorType: PlanSponsorType | null;
  /** Operator-attested: ANY CDI-regulated policy anywhere in the matter,
   *  including secondary/COB ("Life & Health" in the entity name is the tell). */
  secondaryCoverageCdi: boolean | null;
  /** Operator-attested: TRICARE / VA / other government program in the matter
   *  (Medicare / Medicaid arrive via the classification). */
  governmentProgram: boolean | null;
  /** claims.metadata.guideSteps["screening:litigation"] (true = attested yes; null = never asked). */
  litigationAttested: boolean | null;
  /** claims.metadata.collector present — the bill is in collections. */
  inCollections: boolean;
  /** Operator-attested: did the member ask Candid what to argue? null = not asked. */
  memberAskedWhatToArgue: boolean | null;
  /** The 42 CFR Part 2 screen: do any records in the matter come from a
   *  substance-use-disorder treatment provider? Those need a Part 2-compliant
   *  consent Candid does not yet offer — true/null decline (fail closed). */
  part2Records: boolean | null;
  /** The member's own composition events on the claim (ground_selected + letter_adopted). */
  compositionEvents: { groundSelected: boolean; letterAdopted: boolean };
  /** The adverse determination the appeal answers (denial notice date, YYYY-MM-DD). */
  adverseDeterminationDate: string | null;
  /** Business days of runway to the governing deadline (deadline engine); null = unknown. */
  runwayBusinessDays: number | null;
  /** Config: refusal_runway_business_days (R18). */
  refusalRunwayBusinessDays: number;
  /** Config: marketing_gate_verified_on (Gate 6). */
  marketingGateVerifiedOn: string | null;
}

export type GateId = "lane" | "0" | "1" | "2" | "3" | "4" | "5" | "6" | "runway";

export interface GateResult {
  id: GateId;
  label: string;
  pass: boolean;
  /** Why it failed — plain words, written into the decline. Null when it passed. */
  reason: string | null;
}

export interface IntakeDecision {
  eligible: boolean;
  gates: GateResult[];
  /** The FIRST failing gate's reason (the mock's "declined — …" line). */
  declineReason: string | null;
  lane: "insurer";
  /** Gate 4 — state-level filings are signed and filed by the member. */
  memberFilesAtStateLevel: true;
}

export const GATE_LABELS: Readonly<Record<GateId, string>> = {
  lane: "state lane open",
  "0": "execution-only",
  "1": "regulator named in docs",
  "2": "accepted plan class",
  "3": "no hard-excludes",
  "4": "member-files split OK",
  "5": "fee after denial",
  "6": "marketing clean",
  runway: "deadline runway",
};

function gate(id: GateId, pass: boolean, reason: string | null): GateResult {
  return { id, label: GATE_LABELS[id], pass, reason: pass ? null : reason };
}

/** Gate 1 + the first half of Gate 2: which proven class the documents put the plan in. */
export function acceptedPlanClass(
  c: RegulatoryClassification | null,
): "dmhc_plan" | "self_funded_erisa" | "self_funded_public" | null {
  if (!c) return null;
  if (c.coverageType === "commercial_fully_insured") return c.caRegulator === "DMHC" ? "dmhc_plan" : null;
  if (c.coverageType === "employer_self_funded") return "self_funded_erisa";
  if (c.coverageType === "employer_self_funded_public") return "self_funded_public";
  return null;
}

export function evaluateIntake(f: IntakeFacts): IntakeDecision {
  const gates: GateResult[] = [];

  gates.push(
    gate("lane", dfyLaneOpen(f.memberState), f.memberState
      ? `the lane is not open in ${f.memberState.trim().toUpperCase()}`
      : "the member's state is not on file"),
  );

  // Gate 0 — conduct: the member selected the grounds and adopted the letter,
  // and did not ask us what to argue.
  const composed = f.compositionEvents.groundSelected && f.compositionEvents.letterAdopted;
  gates.push(
    gate(
      "0",
      composed && f.memberAskedWhatToArgue === false,
      !composed
        ? "the member has not composed the appeal themselves (no ground selection + adoption on record)"
        : f.memberAskedWhatToArgue === null
          ? "not yet recorded whether the member asked what to argue"
          : "needs judgment, not execution → free tool",
    ),
  );

  // Gate 1 — the contract from DOCUMENTS: the regulator the member's own
  // documents name. No regulator named, or CDI named → decline.
  const cls = acceptedPlanClass(f.classification);
  gates.push(
    gate(
      "1",
      cls !== null,
      !f.classification
        ? "no plan classification on record (undocumented funding)"
        : f.classification.coverageType === "commercial_fully_insured"
          ? f.classification.caRegulator === "CDI"
            ? "the documents name CDI (excluded regulator)"
            : "no regulator named in the documents"
          : "coverage class is not an accepted class",
    ),
  );

  // Gate 2 — accepted classes only: DMHC plan · single-employer self-funded
  // ERISA · self-funded governmental/church. MEWA/PEO fails HERE too — "self-funded" does not save them.
  const classOk =
    cls === "dmhc_plan" ||
    (cls === "self_funded_erisa" && f.planSponsorType === "single_employer") ||
    (cls === "self_funded_public" && f.planSponsorType === "single_employer");
  gates.push(
    gate(
      "2",
      classOk,
      cls === null
        ? "no accepted plan class"
        : f.planSponsorType === null || f.planSponsorType === "unknown"
          ? "plan sponsor type not yet confirmed from the documents"
          : "plan sponsor type is not a single employer",
    ),
  );

  // Gate 3 — hard excludes, any one of which declines.
  const excludes: string[] = [];
  if (f.secondaryCoverageCdi !== false)
    excludes.push(
      f.secondaryCoverageCdi === true
        ? "a CDI-regulated policy is in the matter (secondary/COB)"
        : "secondary coverage not yet checked",
    );
  if (f.planSponsorType === "mewa_association_peo") excludes.push("MEWA / association / PEO plan");
  const ct = f.classification?.coverageType;
  if (ct === "medicare" || ct === "medicaid") excludes.push(`${ct} coverage`);
  if (ct === "uninsured_self_pay") excludes.push("no insurer to appeal to");
  if (f.governmentProgram !== false)
    excludes.push(f.governmentProgram === true ? "a government program (TRICARE / VA) is in the matter" : "government-program check not yet answered");
  if (f.litigationAttested !== false)
    excludes.push(f.litigationAttested === true ? "a lawsuit is on record" : "litigation screening not yet answered");
  if (f.inCollections) excludes.push("the bill is in collections");
  if (f.part2Records !== false)
    excludes.push(
      f.part2Records === true
        ? "records from a substance-use treatment provider need a separate consent we don't offer yet"
        : "the substance-use-records (42 CFR Part 2) screen is not yet answered",
    );
  if (f.memberAskedWhatToArgue !== false) excludes.push("the member asked what to argue");
  gates.push(gate("3", excludes.length === 0, excludes.length ? excludes.join(" · ") : null));

  // Gate 4 — the forum split is a SERVICE SHAPE, not a screen: DMHC-level
  // filings are signed and filed by the member. Recorded so the scope says so.
  gates.push(gate("4", true, null));

  // Gate 5 — fee timing: per matter, only after an adverse determination exists.
  gates.push(gate("5", !!f.adverseDeterminationDate, "no adverse determination on record yet"));

  // Gate 6 — marketing: global, attested by date in config. Null fails closed.
  gates.push(
    gate("6", !!f.marketingGateVerifiedOn, "the approved marketing sweep is not yet verified complete"),
  );

  // R18 — deadline runway below the refusal threshold declines at intake.
  const runwayOk = f.runwayBusinessDays !== null && f.runwayBusinessDays >= f.refusalRunwayBusinessDays;
  gates.push(
    gate(
      "runway",
      runwayOk,
      f.runwayBusinessDays === null
        ? "the governing deadline is unknown"
        : `${f.runwayBusinessDays} business days of runway is below the ${f.refusalRunwayBusinessDays}-day threshold`,
    ),
  );

  const firstFail = gates.find((g) => !g.pass) ?? null;
  return {
    eligible: firstFail === null,
    gates,
    declineReason: firstFail ? firstFail.reason : null,
    lane: "insurer",
    memberFilesAtStateLevel: true,
  };
}
