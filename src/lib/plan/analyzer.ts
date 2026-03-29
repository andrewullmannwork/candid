// Candid Plan — Benefits analyzer
// Takes a user's insurance profile and returns relevant underused benefits.

import {
  BENEFITS_CATALOG,
  BENEFIT_CATEGORY_LABELS,
  type Benefit,
  type BenefitCategory,
  type DemographicCriteria,
} from "./benefits-catalog";

export interface PlanAnalysisInput {
  insurer: string;
  planType: string;
  state: string;
  // Demographics for personalized sorting
  dateOfBirth?: string;
  sex?: string;
  hasDependents?: boolean;
  hasChildren?: boolean;
}

export interface PlanAnalysisResult {
  benefits: AnalyzedBenefit[];
  categoryCounts: Record<string, number>;
  totalBenefits: number;
  profileComplete: boolean;
  missingFields: string[];
}

export interface AnalyzedBenefit {
  benefit: Benefit;
  categoryLabel: string;
  relevanceNote?: string; // Why this is relevant to this user's plan
  relevanceScore: number; // 0-100, higher = more relevant to this specific user
  isRecommended: boolean; // Demographically recommended
}

export function analyzePlan(input: PlanAnalysisInput): PlanAnalysisResult {
  const missingFields: string[] = [];
  if (!input.insurer) missingFields.push("insurer");
  if (!input.planType) missingFields.push("plan type");
  if (!input.state) missingFields.push("state");

  const profileComplete = missingFields.length === 0;

  // Filter benefits relevant to this user's plan type
  const relevantBenefits = BENEFITS_CATALOG.filter((benefit) => {
    // Exclude if plan type is explicitly excluded
    if (
      benefit.excludedPlanTypes &&
      benefit.excludedPlanTypes.includes(input.planType)
    ) {
      return false;
    }

    // Include if plan type matches (or if no plan type provided, show all)
    if (!input.planType) return true;
    return benefit.planTypes.includes(input.planType);
  });

  // Filter by state-specific benefits
  const stateFiltered = relevantBenefits.filter((benefit) => {
    if (!benefit.states || benefit.states.length === 0) return true;
    if (!input.state) return true;
    return benefit.states.includes(input.state);
  });

  // Calculate user age from DOB
  const userAge = input.dateOfBirth ? getAge(input.dateOfBirth) : undefined;

  // Hard-exclude benefits that don't match user's sex or children status
  const demographicFiltered = stateFiltered.filter((benefit) => {
    const rec = benefit.recommendedFor;
    if (!rec) return true; // No demographic criteria — include

    // Hard exclusion: sex-specific benefits (e.g. breast pump for males, prostate for females)
    if (rec.sex && input.sex && rec.sex !== input.sex) return false;

    // Hard exclusion: children-required benefits when user has no children
    if (rec.hasChildren && input.hasChildren === false) return false;

    return true;
  });

  // Build analyzed benefits with relevance notes and scores
  const analyzed: AnalyzedBenefit[] = demographicFiltered.map((benefit) => {
    const score = computeRelevanceScore(benefit, input, userAge);
    return {
      benefit,
      categoryLabel: BENEFIT_CATEGORY_LABELS[benefit.category],
      relevanceNote: getRelevanceNote(benefit, input),
      relevanceScore: score,
      isRecommended: score >= 70,
    };
  });

  // Sort: recommended first, then by score descending
  analyzed.sort((a, b) => b.relevanceScore - a.relevanceScore);

  // Count by category
  const categoryCounts: Record<string, number> = {};
  for (const item of analyzed) {
    const cat = item.categoryLabel;
    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
  }

  return {
    benefits: analyzed,
    categoryCounts,
    totalBenefits: analyzed.length,
    profileComplete,
    missingFields,
  };
}

function getAge(dateOfBirth: string): number {
  const dob = new Date(dateOfBirth);
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const m = today.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
  return age;
}

function computeRelevanceScore(
  benefit: Benefit,
  input: PlanAnalysisInput,
  userAge?: number
): number {
  let score = 50; // Base score for plan-type-matched benefits

  const rec = benefit.recommendedFor;
  if (!rec) return score; // No demographic criteria = neutral relevance

  let demographicMatch = true;
  let matchCount = 0;

  // Age check
  if (rec.minAge != null || rec.maxAge != null) {
    if (userAge != null) {
      const ageMatch =
        (rec.minAge == null || userAge >= rec.minAge) &&
        (rec.maxAge == null || userAge <= rec.maxAge);
      if (ageMatch) {
        score += 25;
        matchCount++;
      } else {
        demographicMatch = false;
        score -= 15;
      }
    }
    // If age unknown, don't penalize
  }

  // Sex check
  if (rec.sex) {
    if (input.sex) {
      if (input.sex === rec.sex) {
        score += 15;
        matchCount++;
      } else {
        demographicMatch = false;
        score -= 20; // Strong signal — e.g. prostate screening for females
      }
    }
  }

  // Dependents check
  if (rec.hasDependents && input.hasDependents) {
    score += 10;
    matchCount++;
  }
  if (rec.hasChildren && input.hasChildren) {
    score += 10;
    matchCount++;
  }

  // Maternity deprioritization: male with no dependents → push to bottom
  if (benefit.category === "maternity" && input.sex === "male" && !input.hasDependents) {
    score -= 30;
  }

  // Bonus for multiple matches
  if (matchCount >= 2) score += 10;

  return Math.max(0, Math.min(100, score));
}

function getRelevanceNote(
  benefit: Benefit,
  input: PlanAnalysisInput
): string | undefined {
  // HSA/FSA benefits are only relevant for HDHP
  if (benefit.category === "hsa_fsa" && input.planType === "HDHP") {
    return "Your HDHP plan comes with an HSA — these are eligible expenses.";
  }

  // Medicare-specific notes
  if (
    input.planType === "Medicare" ||
    input.planType === "Medicare Advantage"
  ) {
    if (benefit.id === "gym-reimbursement") {
      return "Check for SilverSneakers or Active&Fit Direct through your plan.";
    }
    if (benefit.id === "chronic-care-mgmt") {
      return "Medicare covers 80% of CCM after your deductible.";
    }
  }

  // HMO referral notes
  if (input.planType === "HMO") {
    if (
      benefit.id === "physical-therapy" ||
      benefit.id === "nutritional-counseling"
    ) {
      return "Your HMO plan likely requires a referral — ask your PCP.";
    }
  }

  // PPO direct access notes
  if (input.planType === "PPO") {
    if (benefit.id === "physical-therapy") {
      return "Most PPO plans allow direct access to PTs without a referral.";
    }
  }

  return undefined;
}

// Group benefits by category for display
export function groupByCategory(
  benefits: AnalyzedBenefit[]
): Map<BenefitCategory, AnalyzedBenefit[]> {
  const groups = new Map<BenefitCategory, AnalyzedBenefit[]>();

  for (const item of benefits) {
    const cat = item.benefit.category;
    if (!groups.has(cat)) {
      groups.set(cat, []);
    }
    groups.get(cat)!.push(item);
  }

  return groups;
}
