/**
 * Legal Disclaimers — single source of truth for all disclaimer text.
 *
 * Every user-facing output with analysis, recommendations, or generated
 * content must carry the appropriate disclaimer. UI components use
 * <Disclaimer variant="..." /> which reads from these constants.
 */

export type DisclaimerVariant =
  | "dispute_letter"
  | "discrepancy_alert"
  | "coverage_check"
  | "pricing_care"
  | "negotiation_letter"
  | "small_claims"
  | "accuracy_rate"
  | "network_evidence";

export const DISCLAIMERS: Record<DisclaimerVariant, string> = {
  dispute_letter:
    "This letter was prepared using Candid, a consumer billing analysis tool. Candid is not a law firm, does not provide legal advice, and does not act as your legal representative. The information above is based on anonymized, aggregated community data and publicly available rates, and may not reflect your specific contractual rates or coverage. You should consult with a qualified attorney if you need legal advice regarding your medical bills.",

  discrepancy_alert:
    "This discrepancy is based on your uploaded plan documents and community data. It may not reflect all terms, exclusions, or amendments to your specific coverage. Review your full plan document or contact your insurer before taking action.",

  coverage_check:
    "Coverage information is based on documents you\u2019ve uploaded and may not reflect your complete plan terms. Services shown as \u201cnot covered\u201d may have exceptions or conditions not captured in our analysis. Always verify with your insurer before making healthcare decisions.",

  pricing_care:
    "Pricing estimates are based on anonymized, aggregated community data and publicly available rates. Actual costs vary by provider, insurance plan, and individual circumstances. Contact providers directly for current pricing. This is not a guarantee of cost.",

  negotiation_letter:
    "This letter is informational only. Candid does not negotiate on your behalf and does not provide legal advice. You are responsible for reviewing, sending, and managing all communications with providers. Consider consulting a patient advocate or attorney for complex billing disputes.",

  small_claims:
    "Candid does not provide legal advice. This information is for educational purposes only and may not reflect current court rules, filing requirements, or deadlines. Court information may be outdated \u2014 verify directly with your local court. Consider consulting an attorney before filing.",

  accuracy_rate:
    "Success rates are based on limited community data and past outcomes. They do not predict the result of your specific dispute. Individual results vary based on plan terms, insurer policies, and specific circumstances.",

  network_evidence:
    "Community data is based on anonymized reports from other Candid users on similar plans. Individual plan terms may differ. This data supports your case but is not definitive proof of your specific coverage terms. Candid does not organize class actions or provide legal strategy.",
};
