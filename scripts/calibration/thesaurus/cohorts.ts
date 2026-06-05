/** Compare-cohort definitions (frozen). 20 fixed 3-plan cohorts for B3. */
import { readFileSync } from "fs";

export interface CohortDef {
  cohortId: string;
  /** exactly 3 canonical_plan_id UUIDs */
  canonicalPlanIds: string[];
  /** why this cohort (e.g. "gap-prone: sparse-service Bronze") — selection rationale, frozen. */
  rationale: string;
}

export function loadCohortDefs(path: string): CohortDef[] {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const arr: CohortDef[] = Array.isArray(raw) ? raw : raw.cohorts ?? [];
  for (const c of arr) {
    if (!c.cohortId || !Array.isArray(c.canonicalPlanIds) || c.canonicalPlanIds.length !== 3) {
      throw new Error(`cohort ${c.cohortId ?? "?"}: must have exactly 3 canonicalPlanIds`);
    }
  }
  return arr;
}
