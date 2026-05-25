// Candid Plan — Benefits catalog
// Rule-based mapping of plan types and insurers to commonly underused benefits.
// These are general categories, not specific plan details. Users are always
// directed to contact their insurer for verification.

export interface DemographicCriteria {
  minAge?: number;
  maxAge?: number;
  sex?: "male" | "female";
  hasDependents?: boolean;
  hasChildren?: boolean; // Has dependents with relationship "child"
}

export interface Benefit {
  id: string;
  category: BenefitCategory;
  title: string;
  description: string;
  whyUnderutilized: string;
  howToAccess: string;
  hsaFsaEligible: boolean;
  planTypes: string[]; // Which plan types typically include this
  excludedPlanTypes?: string[]; // Plan types that typically don't cover this
  states?: string[]; // State-specific mandates (empty = all states)
  recommendedFor?: DemographicCriteria; // If set, benefit is prioritized for matching users
}

export type BenefitCategory =
  | "preventive_care"
  | "mental_health"
  | "nutrition"
  | "physical_therapy"
  | "hsa_fsa"
  | "telehealth"
  | "chronic_care"
  | "wellness"
  | "maternity"
  | "vision_dental";

export const BENEFIT_CATEGORY_LABELS: Record<BenefitCategory, string> = {
  preventive_care: "Preventive Care",
  mental_health: "Mental Health",
  nutrition: "Nutrition & Dietitian",
  physical_therapy: "Physical Therapy & Rehab",
  hsa_fsa: "HSA/FSA Eligible Services",
  telehealth: "Telehealth",
  chronic_care: "Chronic Care Management",
  wellness: "Wellness Programs",
  maternity: "Maternity & Family Planning",
  vision_dental: "Vision & Dental",
};

// All plan types from the profile form
const ALL_COMMERCIAL = ["HMO", "PPO", "EPO", "HDHP", "OAP", "POS"];
const ALL_PLANS = [...ALL_COMMERCIAL, "Medicare", "Medicare Advantage", "Medicaid"];

export const BENEFITS_CATALOG: Benefit[] = [
  // ── Preventive Care ──────────────────────────────────────────────────
  {
    id: "annual-physical",
    category: "preventive_care",
    title: "Annual Physical / Wellness Visit",
    description:
      "Most plans cover one annual wellness visit at no cost. This is separate from a sick visit and includes routine screenings, blood pressure, BMI, and health risk assessment.",
    whyUnderutilized:
      "Many people skip their annual physical because they feel healthy. But preventive visits catch issues early and are fully covered — no copay, no deductible.",
    howToAccess:
      "Schedule with your primary care provider and confirm it's coded as a preventive/wellness visit (not a problem-focused visit) to avoid surprise charges.",
    hsaFsaEligible: false, // Already $0
    planTypes: ALL_PLANS,
  },
  {
    id: "cancer-screenings",
    category: "preventive_care",
    title: "Cancer Screenings (Colonoscopy, Mammogram, Pap Smear)",
    description:
      "Preventive cancer screenings are covered at no cost under the ACA for age-appropriate patients. Colonoscopy (45+), mammogram (40+), Pap smear (21+), and lung cancer screening (50+ with smoking history).",
    whyUnderutilized:
      "People delay screenings out of discomfort or assume they'll be expensive. Under the ACA, preventive screenings must be covered at $0 cost-share.",
    howToAccess:
      "Ask your doctor to order the screening as preventive (not diagnostic). If a polyp is found during a colonoscopy, some plans may apply cost-sharing for the removal — ask beforehand.",
    hsaFsaEligible: false,
    planTypes: ALL_PLANS,
    recommendedFor: { minAge: 40 },
  },
  {
    id: "vaccinations",
    category: "preventive_care",
    title: "Vaccinations (Flu, Shingles, Pneumonia, Hepatitis)",
    description:
      "Adult vaccines recommended by ACIP are covered at no cost under the ACA. This includes flu, shingles (50+), pneumonia (65+), Tdap, Hepatitis B, and HPV (through age 26).",
    whyUnderutilized:
      "Many adults don't realize vaccines beyond the flu shot are covered. Shingles and pneumonia vaccines alone can prevent thousands in future medical costs.",
    howToAccess:
      "Get vaccinated at your doctor's office or an in-network pharmacy. Confirm the provider is in-network to avoid charges.",
    hsaFsaEligible: false,
    planTypes: ALL_PLANS,
    recommendedFor: { minAge: 50 },
  },
  {
    id: "diabetes-screening",
    category: "preventive_care",
    title: "Diabetes & Cholesterol Screening",
    description:
      "Blood glucose and lipid panel tests are covered preventively for adults with risk factors (BMI ≥25, family history, age 35+). Most plans cover these at no cost.",
    whyUnderutilized:
      "People assume blood work is expensive. Preventive lab panels ordered at annual visits are typically covered at $0.",
    howToAccess:
      "Request during your annual wellness visit. Make sure the lab is in-network.",
    hsaFsaEligible: false,
    planTypes: ALL_PLANS,
    recommendedFor: { minAge: 35 },
  },

  // ── Mental Health ────────────────────────────────────────────────────
  {
    id: "therapy-sessions",
    category: "mental_health",
    title: "Outpatient Therapy / Counseling",
    description:
      "Most commercial plans cover outpatient mental health therapy (individual and group) under the Mental Health Parity Act. This includes psychotherapy, CBT, and licensed counseling.",
    whyUnderutilized:
      "Stigma and the belief that therapy isn't covered. Federal parity law requires mental health coverage to be on par with medical/surgical benefits.",
    howToAccess:
      "Search your insurer's provider directory for in-network therapists. Many plans now cover telehealth therapy with the same benefits.",
    hsaFsaEligible: true,
    planTypes: ALL_PLANS,
  },
  {
    id: "substance-abuse",
    category: "mental_health",
    title: "Substance Use Disorder Treatment",
    description:
      "ACA-compliant plans must cover substance use disorder treatment as an essential health benefit, including outpatient counseling and medication-assisted treatment (MAT).",
    whyUnderutilized:
      "People don't realize their plan covers addiction treatment, or assume it requires prior authorization. Many plans cover it with standard mental health benefits.",
    howToAccess:
      "Call the behavioral health number on your insurance card (often different from the main number). Ask about covered programs and whether prior auth is needed.",
    hsaFsaEligible: true,
    planTypes: ALL_COMMERCIAL,
  },
  {
    id: "psychiatric-eval",
    category: "mental_health",
    title: "Psychiatric Evaluation & Medication Management",
    description:
      "Initial psychiatric evaluations and ongoing medication management visits are typically covered. This includes ADHD, anxiety, depression, and bipolar disorder treatment.",
    whyUnderutilized:
      "Long wait times for psychiatrists make people assume they're not accessible through insurance. Telehealth psychiatry has dramatically improved access.",
    howToAccess:
      "Ask your insurer about in-network psychiatrists or telehealth psychiatric services. Many plans cover virtual psychiatric visits.",
    hsaFsaEligible: true,
    planTypes: ALL_PLANS,
  },

  // ── Nutrition & Dietitian ────────────────────────────────────────────
  {
    id: "nutritional-counseling",
    category: "nutrition",
    title: "Nutritional Counseling / Registered Dietitian",
    description:
      "Many plans cover visits with a registered dietitian, especially for diabetes, obesity (BMI ≥30), heart disease, or eating disorders. Some cover general wellness nutrition.",
    whyUnderutilized:
      "Most people don't know dietitian visits are a covered benefit. Under the ACA, obesity screening and counseling are covered preventively.",
    howToAccess:
      "Ask your doctor for a referral (some plans require it). Search your insurer's directory for in-network registered dietitians.",
    hsaFsaEligible: true,
    planTypes: ALL_PLANS,
  },
  {
    id: "diabetes-prevention",
    category: "nutrition",
    title: "Diabetes Prevention Program (DPP)",
    description:
      "CDC-recognized Diabetes Prevention Programs are covered by Medicare and many commercial plans. Year-long programs with coaching on nutrition, exercise, and weight management.",
    whyUnderutilized:
      "Low awareness. The DPP is specifically designed for people with prediabetes and has strong clinical evidence for preventing type 2 diabetes.",
    howToAccess:
      "Ask your doctor if you qualify (typically prediabetes diagnosis). Search for CDC-recognized DPP programs in your area or online.",
    hsaFsaEligible: true,
    planTypes: ["PPO", "HMO", "EPO", "Medicare", "Medicare Advantage"],
    recommendedFor: { minAge: 40 },
  },

  // ── Physical Therapy & Rehab ─────────────────────────────────────────
  {
    id: "physical-therapy",
    category: "physical_therapy",
    title: "Physical Therapy",
    description:
      "Most plans cover physical therapy for injury recovery, chronic pain, post-surgical rehab, and musculoskeletal conditions. Many plans offer 20–60 visits per year.",
    whyUnderutilized:
      "People assume they need a referral or that PT is only for post-surgery. Many PPO and EPO plans allow direct access to physical therapists.",
    howToAccess:
      "Check if your plan requires a referral (HMOs usually do, PPOs often don't). Find in-network PTs in your insurer's directory.",
    hsaFsaEligible: true,
    planTypes: ALL_PLANS,
  },
  {
    id: "occupational-therapy",
    category: "physical_therapy",
    title: "Occupational Therapy",
    description:
      "Covered for conditions affecting daily activities — carpal tunnel, arthritis, stroke recovery, developmental delays. Often bundled with PT benefits.",
    whyUnderutilized:
      "People associate OT only with children or severe disabilities. Adults with repetitive strain injuries, chronic conditions, or post-surgical needs often qualify.",
    howToAccess:
      "Get a referral from your doctor. Ask specifically about OT coverage limits (separate from PT in many plans).",
    hsaFsaEligible: true,
    planTypes: ALL_PLANS,
  },

  // ── HSA/FSA Eligible Services ────────────────────────────────────────
  {
    id: "hsa-body-scan",
    category: "hsa_fsa",
    title: "Full-Body Health Scan / Advanced Screening",
    description:
      "HSA/FSA funds can pay for preventive body scans (DEXA, CT calcium scoring, full-body MRI at consumer clinics). These catch conditions before symptoms appear.",
    whyUnderutilized:
      "People don't realize HSA/FSA funds cover preventive screenings beyond what insurance pays for. These are out-of-pocket expenses that your tax-advantaged account can cover.",
    howToAccess:
      "Pay out of pocket at the screening facility and reimburse yourself from your HSA/FSA. Keep the receipt with the diagnosis code.",
    hsaFsaEligible: true,
    planTypes: ["HDHP"], // HSA requires HDHP
    excludedPlanTypes: ["Medicaid"],
  },
  {
    id: "hsa-lab-panels",
    category: "hsa_fsa",
    title: "Direct-to-Consumer Lab Panels",
    description:
      "HSA/FSA funds cover lab tests ordered through direct-to-consumer services (comprehensive metabolic panels, thyroid, hormone panels, vitamin levels) without a doctor visit.",
    whyUnderutilized:
      "Many people don't know they can order lab work themselves and pay with HSA/FSA. Prices are often lower than through insurance.",
    howToAccess:
      "Order through a direct-to-consumer lab service, pay with your HSA/FSA debit card. Results are typically available online within days.",
    hsaFsaEligible: true,
    planTypes: ["HDHP"],
    excludedPlanTypes: ["Medicaid"],
  },
  {
    id: "fsa-otc-medications",
    category: "hsa_fsa",
    title: "Over-the-Counter Medications & Supplies",
    description:
      "Since the CARES Act (2020), HSA/FSA funds cover all OTC medications without a prescription — pain relievers, allergy meds, first aid supplies, sunscreen, menstrual products.",
    whyUnderutilized:
      "Many people still think OTC meds require a prescription for HSA/FSA. The CARES Act permanently removed this requirement.",
    howToAccess:
      "Pay with your HSA/FSA debit card at any pharmacy or retailer. Most major retailers now flag HSA/FSA-eligible items.",
    hsaFsaEligible: true,
    planTypes: ["HDHP"],
    excludedPlanTypes: ["Medicaid"],
  },

  // ── Telehealth ───────────────────────────────────────────────────────
  {
    id: "telehealth-primary",
    category: "telehealth",
    title: "Telehealth Primary Care Visits",
    description:
      "Most plans now cover telehealth visits at the same rate as in-person visits — some with $0 copay. Covers urgent care, prescription refills, follow-ups, and minor illness.",
    whyUnderutilized:
      "People default to in-person visits out of habit. Telehealth often has shorter wait times, no travel, and sometimes lower copays.",
    howToAccess:
      "Check your insurer's app or website for their preferred telehealth platform (Teladoc, MDLive, Amwell, etc.). Many are built into the insurer's app.",
    hsaFsaEligible: true,
    planTypes: ALL_PLANS,
  },
  {
    id: "telehealth-therapy",
    category: "telehealth",
    title: "Telehealth Therapy & Psychiatry",
    description:
      "Virtual therapy and psychiatric sessions are covered by most plans at parity with in-person visits. Dramatically expands access to mental health providers.",
    whyUnderutilized:
      "People assume telehealth therapy is inferior or not covered. Studies show comparable outcomes to in-person therapy for most conditions.",
    howToAccess:
      "Search your insurer's directory filtering for telehealth providers, or ask about dedicated behavioral health platforms included in your plan.",
    hsaFsaEligible: true,
    planTypes: ALL_PLANS,
  },

  // ── Chronic Care Management ──────────────────────────────────────────
  {
    id: "chronic-care-mgmt",
    category: "chronic_care",
    title: "Chronic Care Management (CCM) Programs",
    description:
      "For patients with 2+ chronic conditions (diabetes, hypertension, COPD, etc.), Medicare and many commercial plans cover monthly care coordination — a nurse/care manager who tracks your conditions, coordinates specialists, and manages medications.",
    whyUnderutilized:
      "Most patients don't know CCM exists. Providers often don't mention it because the reimbursement process is complex.",
    howToAccess:
      "Ask your primary care provider if they offer CCM services. You must consent to enrollment. Medicare covers 80% after deductible.",
    hsaFsaEligible: true,
    planTypes: ["Medicare", "Medicare Advantage", "PPO", "HMO"],
    recommendedFor: { minAge: 50 },
  },
  {
    id: "remote-monitoring",
    category: "chronic_care",
    title: "Remote Patient Monitoring (RPM)",
    description:
      "Medicare and some commercial plans cover devices and monitoring for chronic conditions — blood pressure cuffs, glucose monitors, pulse oximeters — with data transmitted to your care team.",
    whyUnderutilized:
      "Relatively new benefit. Many patients manage chronic conditions without realizing their insurer will pay for monitoring devices and the care team oversight.",
    howToAccess:
      "Ask your doctor about RPM programs. Medicare requires the monitoring device to transmit data at least 16 days per month.",
    hsaFsaEligible: true,
    planTypes: ["Medicare", "Medicare Advantage", "PPO"],
  },

  // ── Wellness Programs ────────────────────────────────────────────────
  {
    id: "gym-reimbursement",
    category: "wellness",
    title: "Gym Membership / Fitness Reimbursement",
    description:
      "Many commercial plans include gym membership reimbursement ($150–$600/year) or access to fitness networks like SilverSneakers (Medicare) or Active&Fit Direct.",
    whyUnderutilized:
      "Buried in plan documents. Most people don't check if their insurer subsidizes gym memberships.",
    howToAccess:
      "Search your insurer's website for 'fitness benefit' or 'gym reimbursement.' Medicare Advantage: check for SilverSneakers or equivalent.",
    hsaFsaEligible: false,
    planTypes: ALL_PLANS,
  },
  {
    id: "smoking-cessation",
    category: "wellness",
    title: "Smoking Cessation Programs & Medications",
    description:
      "ACA-compliant plans must cover FDA-approved tobacco cessation medications (patches, gum, Chantix) and counseling — typically two quit attempts per year, each with 4 counseling sessions.",
    whyUnderutilized:
      "People buy OTC cessation products out of pocket without realizing their insurance covers prescription options and counseling at no cost.",
    howToAccess:
      "Ask your doctor for a prescription. Confirm your plan covers it as a preventive benefit (no cost-share under ACA).",
    hsaFsaEligible: true,
    planTypes: ALL_COMMERCIAL,
  },

  // ── Maternity & Family Planning ──────────────────────────────────────
  {
    id: "breast-pump",
    category: "maternity",
    title: "Breast Pump Coverage",
    description:
      "ACA requires plans to cover a breast pump at no cost — either rental or purchase. Many plans cover upgraded electric pumps with a small cost difference.",
    whyUnderutilized:
      "New parents often buy pumps out of pocket. Insurance must cover at least a basic pump at $0.",
    howToAccess:
      "Call your insurer's durable medical equipment (DME) line or use an insurer-approved breast pump supplier. Order before or after birth.",
    hsaFsaEligible: false,
    planTypes: ALL_COMMERCIAL,
    recommendedFor: { sex: "female", minAge: 18, maxAge: 45, hasChildren: true },
  },
  {
    id: "contraception",
    category: "maternity",
    title: "Contraception (All FDA-Approved Methods)",
    description:
      "ACA requires coverage of all FDA-approved contraceptive methods at no cost — pills, IUDs, implants, patches, rings, and sterilization. No copay, no deductible.",
    whyUnderutilized:
      "People pay out of pocket for brand-name contraception when generic versions are covered at $0. Even brand-name may be covered with medical justification.",
    howToAccess:
      "Ask your doctor to prescribe a covered method. If your preferred brand isn't covered, request an exception/prior auth.",
    hsaFsaEligible: false,
    planTypes: ALL_COMMERCIAL,
    recommendedFor: { sex: "female", minAge: 18, maxAge: 50 },
  },

  // ── Therapy & Rehab (additional entries closing SLUG_TO_CATALOG drift) ──
  {
    id: "acupuncture",
    category: "physical_therapy",
    title: "Acupuncture",
    description:
      "Many plans cover acupuncture for pain management — chronic back pain, neck pain, migraines, and osteoarthritis. Coverage varies widely; typical limit is 10–24 sessions per year.",
    whyUnderutilized:
      "People assume acupuncture is alternative medicine and not covered. Since 2020, Medicare covers chronic low back pain acupuncture, and many commercial plans cover it for specific pain diagnoses.",
    howToAccess:
      "Confirm acupuncture is covered for your specific condition (chronic pain diagnoses are most commonly covered). Find a licensed acupuncturist in-network — your insurer's directory usually lists them under specialty providers.",
    hsaFsaEligible: true,
    planTypes: ALL_PLANS,
  },
  {
    id: "chiro-visits",
    category: "physical_therapy",
    title: "Chiropractic Care",
    description:
      "Most commercial plans cover chiropractic care for back pain, neck pain, and joint issues. Typical limit is 12–30 visits per year. Medicare covers spinal manipulation only.",
    whyUnderutilized:
      "People pay out of pocket assuming chiropractic isn't covered, or stop after a few visits without checking their visit limit. Many plans allow direct access without a primary care referral.",
    howToAccess:
      "Check your plan's annual visit limit and whether prior authorization is required after a certain number of visits. Many PPOs let you self-refer to in-network chiropractors.",
    hsaFsaEligible: true,
    planTypes: ALL_COMMERCIAL,
  },
  {
    id: "speech-therapy",
    category: "physical_therapy",
    title: "Speech Therapy",
    description:
      "Plans cover speech-language pathology for developmental delays, stroke recovery, swallowing disorders, and voice rehabilitation. Visit limits typically mirror PT/OT (20–60 sessions per year).",
    whyUnderutilized:
      "People associate speech therapy only with children's speech delays. Adults qualify for stroke recovery, post-surgical voice rehab, swallowing therapy, and aphasia treatment.",
    howToAccess:
      "Get a referral from your doctor specifying the diagnosis. Confirm the SLP is in-network — many speech therapists work outpatient or via telehealth.",
    hsaFsaEligible: true,
    planTypes: ALL_PLANS,
  },
  {
    id: "prenatal-care",
    category: "maternity",
    title: "Prenatal & Postnatal Care",
    description:
      "ACA requires plans to cover prenatal visits, gestational diabetes screening, breastfeeding support, and breast pumps at no cost. Postnatal care for mother + newborn is included.",
    whyUnderutilized:
      "People don't realize how much prenatal care is required to be $0 cost-share under the ACA — including medically necessary ultrasounds, glucose tolerance testing, and lactation consultant visits.",
    howToAccess:
      "Confirm your provider codes visits as preventive maternity care (vs problem-focused). Ask about lactation consultant coverage — many plans cover several visits postpartum at no cost.",
    hsaFsaEligible: false,
    planTypes: ALL_COMMERCIAL,
    recommendedFor: { sex: "female", minAge: 18, maxAge: 45 },
  },
];

// FE→BE request resolution: callers that have a BenefitCategory but no specific
// slug (canonical_plan_services-sourced rows; plan_benefits-sourced rows from
// matched_plan_id / verified-plan paths) use this helper to back-fill prose so
// the /plan UI's "Why people miss this" + "How to access this benefit" sections
// don't silently disappear. First-match semantics — multiple catalog entries
// share a category; the first one wins. Lossy but better than empty.
export function lookupBenefitProseByCategory(
  category: string | null | undefined,
): { whyUnderutilized: string; howToAccess: string } {
  if (!category) return { whyUnderutilized: "", howToAccess: "" };
  const entry = BENEFITS_CATALOG.find((b) => b.category === category);
  return {
    whyUnderutilized: entry?.whyUnderutilized ?? "",
    howToAccess: entry?.howToAccess ?? "",
  };
}
