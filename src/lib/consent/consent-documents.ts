import { createHash } from "crypto";
import type { ConsentType } from "@/lib/supabase/types";

export interface ConsentDocument {
  type: ConsentType;
  version: string;
  effectiveDate: string;
  title: string;
  summary: string;
  fullText: string;
  hash: string;
}

/** Hash the consent text so we can prove what the user saw at consent time. */
function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function defineConsent(
  type: ConsentType,
  version: string,
  effectiveDate: string,
  title: string,
  summary: string,
  fullText: string
): ConsentDocument {
  return { type, version, effectiveDate, title, summary, fullText, hash: hashText(fullText) };
}

// =============================================================================
// CONSENT DOCUMENT REGISTRY
// All consent text is stored in code (not DB) so it's auditable in git history.
// When text changes, bump the version — users on prior versions must re-consent.
// =============================================================================

export const CONSENT_DOCUMENTS: Record<ConsentType, ConsentDocument> = {
  // ===========================================================================
  // #5 — TERMS OF SERVICE (v1.4)
  // Covers: service scope, document prep disclaimer, subscriptions,
  //         IP, liability, indemnification, arbitration, governing law.
  // ===========================================================================
  tos: defineConsent(
    "tos",
    "1.1",
    "2026-04-28",
    "Terms of Service",
    "By creating an account, you agree to our Terms of Service governing your use of Candid.",
    `CANDID TERMS OF SERVICE
Version 1.1 — Effective April 28, 2026
Last Revised: April 28, 2026
Operated by Airgetlam Labs LLC

Version 1.1 amendment: Added §7.10 (No Malpractice Insurance Information) and §7.11 (User Responsibility for Diligence). Candid does not collect, verify, or display attorney malpractice insurance information; marketplace framing requires Users to perform their own diligence. No other substantive changes.

TABLE OF CONTENTS

1. Acceptance of Terms
2. Definitions
3. Description of Services
4. Eligibility and Account Registration
5. Platform Status; No Endorsement
6. User Submissions and Content
7. Lawyer Marketplace
8. Subscription, Fees, and Billing
9. Intellectual Property; Copyright; DMCA
10. Healthcare-Specific Provisions
11. Legal-Services-Specific Provisions
12. Disclaimers and Warranties
13. Limitation of Liability
14. Indemnification
15. Termination
16. Modifications to Terms
17. Dispute Resolution; Arbitration; Class Action Waiver
18. Governing Law; Venue
19. State-Specific Provisions
20. General Provisions
21. Contact Information

1. ACCEPTANCE OF TERMS

These Terms of Service ("Terms") form a binding legal agreement between you ("User," "you," or "your") and Airgetlam Labs LLC, a Delaware limited liability company doing business as Candid ("Candid," "we," "us," or "our"), governing your access to and use of the Candid platform, including the website at www.candidclaim.com, any associated mobile applications, APIs, content, features, and services (collectively, the "Services").

BY ACCESSING, REGISTERING FOR, OR USING THE SERVICES, YOU ACKNOWLEDGE THAT YOU HAVE READ, UNDERSTOOD, AND AGREE TO BE BOUND BY THESE TERMS, INCLUDING THE BINDING ARBITRATION AGREEMENT AND CLASS ACTION WAIVER IN SECTION 17. IF YOU DO NOT AGREE TO THESE TERMS, DO NOT ACCESS OR USE THE SERVICES.

You represent that you are at least eighteen (18) years of age and have the legal capacity to enter into this agreement. The Services are not intended for users under 18.

These Terms incorporate by reference our Privacy Policy (https://www.candidclaim.com/privacy), Community Guidelines (https://www.candidclaim.com/guidelines), and any service-specific terms, all of which form part of this agreement.

2. DEFINITIONS

For purposes of these Terms:

- "Candid Care" means our healthcare price-transparency and provider-quality information service.
- "Candid Case" means our lawyer marketplace and case-file generation service.
- "Candid Claim" means our medical bill audit and dispute-letter generation service, including both free and subscription tiers.
- "Candid Plan" means our health insurance plan benefit analysis service.
- "Content" means all text, data, images, ratings, reviews, comments, documents, and other materials submitted, posted, uploaded, or transmitted through the Services.
- "Listed Lawyer" means an attorney whose profile appears in the Candid Case marketplace pursuant to Section 7.
- "Named Party" means any person or entity (including but not limited to a Listed Lawyer, healthcare provider, hospital, clinic, doctor, or facility) identified by name in User Submissions.
- "User Submission" means any Content authored, submitted, or posted by a User, including ratings, written reviews, corrections, flags, fraud reports, or document uploads.
- "Verified Content" means Content that Candid has independently verified through external sources (such as state bar admission status or NPI directory data). All other Content is "Self-Reported Content" or "User-Generated Content."

3. DESCRIPTION OF SERVICES

Candid provides an information platform that helps users:

- Audit medical bills and insurance claims for billing errors;
- Analyze health insurance plan benefits;
- Generate dispute letters that the User sends themselves;
- Discover attorneys through a marketplace directory (Candid Case);
- Compare healthcare providers and pricing (Candid Care);
- Connect with health-service and supplemental-insurance marketplaces.

Candid is an information services platform. Candid is not a law firm, healthcare provider, insurance broker, financial advisor, credit repair organization, or any other regulated entity unless expressly stated and licensed. Specific service-by-service disclosures are set forth in Sections 10 and 11.

Candid reserves the right to modify, suspend, or discontinue any aspect of the Services at any time, with or without notice, except as otherwise required by law.

4. ELIGIBILITY AND ACCOUNT REGISTRATION

4.1 Eligibility

You must be at least 18 years old and a legal resident of the United States to use the Services. By using the Services, you represent and warrant that you meet these requirements.

4.2 Account Registration

You may be required to register an account to access certain features. You agree to:

(a) provide accurate, current, and complete information;
(b) maintain and promptly update your account information;
(c) maintain the security of your password;
(d) notify Candid immediately of any unauthorized access to your account; and
(e) accept responsibility for all activities that occur under your account.

4.3 Account Termination by You

You may terminate your account at any time through the Services or by contacting us at support@candidclaim.com. Termination of your account does not relieve you of any obligation to pay outstanding fees or charges.

4.4 Account Termination by Candid

Candid may suspend or terminate your account at any time, with or without notice, for any reason, including but not limited to violation of these Terms, the Community Guidelines, or applicable law. Candid is not liable for any loss or damage arising from such termination.

5. PLATFORM STATUS; NO ENDORSEMENT

5.1 Interactive Computer Service

Candid is an interactive computer service provider as defined in 47 U.S.C. § 230. Candid does not author, edit, endorse, ratify, guarantee, warrant, or assume responsibility for the accuracy, completeness, legality, reliability, or quality of any User Submission or third-party content. Candid's role is limited to providing the platform; submitters are solely responsible for their Content.

5.2 No Verification Except as Stated

Candid distinguishes between Verified Content, Self-Reported Content, and User-Generated Content:

- Verified Content means data Candid has confirmed through authoritative external sources, such as state bar admission status (verified through state bar APIs), NPI provider data (verified through NPPES), or licensure records. Verified Content carries a "Verified by Candid" indicator.
- Self-Reported Content means data submitted by Listed Lawyers, healthcare providers, or Users that Candid has not independently verified, including but not limited to: profile photographs, hourly rates, retainer amounts, free consultation availability, specialty self-attestations, language capabilities, accessibility features, and availability status. Self-Reported Content carries a "Self-reported" indicator.
- User-Generated Content means ratings, written reviews, comments, and similar content authored by Users. User-Generated Content reflects the views of the submitter only and does not represent Candid's views.

Candid makes no representation or warranty regarding the accuracy of Self-Reported Content or User-Generated Content. Users are responsible for confirming details with Listed Lawyers, healthcare providers, or other Named Parties before relying on any information.

5.3 No Professional Relationship

Use of the Services does not create any attorney-client, doctor-patient, fiduciary, agency, employment, partnership, or joint venture relationship between you and Candid. Communications through the Services are not privileged or confidential except as expressly provided by these Terms or applicable law.

6. USER SUBMISSIONS AND CONTENT

This Section 6 governs ratings, written reviews, corrections, fraud reports, and other User Submissions concerning Named Parties.

6.1 License Grant

By creating, posting, or submitting any User Submission to the Services, you grant Candid a non-exclusive, royalty-free, worldwide, perpetual, irrevocable, sublicensable, and transferable license to host, store, reproduce, display, publish, distribute, modify, edit (for moderation purposes), translate, create derivative works of, and remove your User Submission, in any media now known or later developed, for the purposes of operating, providing, marketing, and improving the Services. You retain ownership of the underlying intellectual property in your original Content.

6.2 Submitter Representations and Warranties

By submitting any User Submission, you represent and warrant that:

(a) you have full authority to submit the Content;
(b) the Content is true and accurate to the best of your knowledge and belief, and is based on your own first-hand experience or independently verified information;
(c) the Content does not infringe any copyright, trademark, trade secret, right of publicity, right of privacy, or other intellectual property or proprietary right of any third party;
(d) the Content does not contain any defamatory, libelous, threatening, harassing, obscene, or unlawful material;
(e) the Content is your original work or you have obtained all necessary licenses, consents, and approvals;
(f) you are not impersonating another person or entity;
(g) you have no undisclosed conflict of interest with respect to any Named Party (for example, you are not a competitor of a Listed Lawyer reviewing that lawyer);
(h) you are not subject to any legal restriction (such as a non-disclosure or non-disparagement agreement) that prohibits the submission; and
(i) the Content complies with these Terms and the Community Guidelines.

6.3 Pre-Publication Review (Right of Response)

For User Submissions that contain free-text content concerning a Named Party (including written reviews and qualitative comments), Candid will:

(a) provide the Named Party with notification and the opportunity to submit a response within seven (7) calendar days from submission;

(b) display the User Submission with a prominent "Pending [Named Party] Response" badge during the seven-day window, with the Named Party's response (if any) inline upon publication or window expiration;

(c) publish the User Submission, together with any Named Party response, after the seven-day window closes or upon Named Party response, whichever is sooner.

Pre-publication review is a courtesy procedure designed to support fair representation. Pre-publication review does not constitute Candid's verification, fact-checking, endorsement, or legal review of any User Submission. Candid does not warrant the accuracy of any User Submission, before or after publication. Candid's pre-publication procedures are not a substitute for any pre-publication review or retraction demand process required by applicable defamation law in your jurisdiction.

Quantitative or structured-data fields in User Submissions (such as numeric ratings, dollar amounts, and outcome categories) are not subject to the seven-day window and may be aggregated and displayed immediately, subject to k-anonymity thresholds as described in the Community Guidelines.

6.4 Sole Discretion to Moderate or Remove

Candid may, at its sole discretion, with or without notice and with or without cause, remove, edit, refuse to publish, or restrict access to any User Submission. Reasons for removal include but are not limited to: violation of the Community Guidelines, defamation, harassment, slurs or hate speech, off-topic content, conflict of interest, factually disputed claims that the Named Party documents as inaccurate, intellectual property infringement, court order, or any other reason Candid deems appropriate.

Listed reasons in our Community Guidelines are illustrative, not exhaustive. Candid is not obligated to remove any specific Content, and Candid's choice not to remove particular Content does not constitute endorsement or ratification.

6.5 Appeal of Removal

If Candid removes your User Submission, you may appeal the removal decision by contacting us at support@candidclaim.com within fourteen (14) calendar days of removal. Appeals will be reviewed by a senior administrator who was not involved in the original removal decision. The administrator's appeal decision is final and not subject to further appeal within the platform.

Named Parties may not appeal removal of User Submissions concerning them, as such removals are in the Named Party's favor.

6.6 Submitter Anonymity

The identity of submitters is not visible to Named Parties or to other Users. Candid displays only aggregate review counts and anonymized handles. Candid may disclose submitter identity only:

(a) to comply with legal process (subpoena, court order, or law enforcement request);
(b) to investigate suspected fraud or misuse of the Services;
(c) with the submitter's express written consent; or
(d) as otherwise required by law.

Submitters should be aware that Candid's anonymization is operational, not legal. Anonymity does not protect submitters from defamation liability, contractual non-disparagement obligations, or other legal exposures arising from their User Submissions. Submitters are solely responsible for their compliance with applicable law.

6.7 Removal of Content; Audit Retention

Removal of User Submissions from public read paths does not constitute deletion. Candid retains removed Content in internal audit logs for legal compliance, appeals processing, fraud investigation, and other legitimate business purposes. Candid is not obligated to permanently delete any User Submission except as required by applicable law (such as GDPR right-to-erasure requests, CCPA deletion requests, or court orders).

6.8 Aggregate Display; Methodology Disclosure

Candid may display aggregate metrics derived from User Submissions, including but not limited to rating averages, observation counts, and recovery medians. All aggregate metrics displayed publicly are accompanied by methodology disclosure (inline for headline metrics, hover-accessible footnote for per-row metrics). Aggregate metrics with fewer than the applicable k-anonymity threshold of underlying observations are not displayed.

6.9 Fraud Reports

Users may submit reports concerning suspected fraud, identity misrepresentation, or credentialing inaccuracies in Listed Lawyer or healthcare provider profiles. Fraud reports require:

(a) good-faith belief in the accuracy of the report;
(b) supporting information (such as a URL, document, or specific factual basis); and
(c) acknowledgment that knowingly false fraud reports may constitute defamation or tortious interference and may result in account termination.

Fraud reports are subject to anti-abuse rate-limiting and routed to Candid's fraud investigation queue.

7. LAWYER MARKETPLACE

7.1 Directory, Not Referral Service

The Candid Case marketplace is a paid directory of attorneys who self-onboard and pay a flat fee to be listed. Candid does not function as a "lawyer referral service" as defined in any state's lawyer referral statutes or rules. Candid does not refer specific Users to specific Listed Lawyers. Users select Listed Lawyers based on Listed Lawyers' self-reported and verified profile data, filters, and ratings, and contact Listed Lawyers directly.

7.2 Flat Fee Structure

Listed Lawyers pay Candid a flat periodic fee (or, in some cases, a free promotional listing) to maintain a marketplace listing. Candid does not receive, request, or accept any payment that is contingent on, calculated by reference to, or in any way related to: the User's selection of a particular Listed Lawyer, the User's engagement of a particular Listed Lawyer, the outcome of any matter handled by a Listed Lawyer, or any monetary recovery received by a User. Candid's compensation from Listed Lawyers is structured to comply with ABA Model Rule of Professional Conduct 7.2 and analogous state rules.

7.3 No Legal Advice

Candid does not provide legal advice. Information in the Candid Case marketplace, including specialty descriptions, listed rates, and aggregate metrics, is informational only. The selection of an attorney for any specific matter is a decision the User must make based on the User's own circumstances, possibly with the advice of an attorney. Listed Lawyers' biographical, qualification, and rate information is Self-Reported Content (except for state bar admission and disciplinary status, which are Verified Content) and is not warranted by Candid.

7.4 No Attorney-Client Relationship Through Candid

Use of the Candid Case marketplace does not create an attorney-client relationship between you and any Listed Lawyer or between you and Candid. An attorney-client relationship is formed only by direct engagement with a Listed Lawyer outside the Services.

7.5 Communications Through Candid Are Not Privileged

Pre-engagement communications between Users and Listed Lawyers conducted through Candid's marketplace messaging (if any) are not subject to attorney-client privilege. Candid recommends that Users not transmit confidential or privileged information through the Services. Users should communicate sensitive information directly with Listed Lawyers through privileged channels established by the User's engagement.

7.6 Lawyer Verification and Suspension

Candid verifies Listed Lawyer state bar admission and disciplinary status through state bar APIs at onboarding and on a periodic basis. Candid will suspend or remove a Listed Lawyer from the marketplace upon:

(a) bar discipline of any kind (immediate suspension);
(b) three (3) or more substantiated User complaints within ninety (90) days;
(c) ninety (90) days or more of stale state bar verification status;
(d) non-responsiveness or other operational issues affecting Users; or
(e) any other circumstance Candid deems warrants suspension.

7.7 Re-Listing After Removal

Listed Lawyers whose listings have been removed by Candid may apply for a new listing pursuant to Candid's re-listing procedures. Re-listed lawyers must disclose, in their new profile, that a prior listing was removed, including the date and category of removal. Candid uses NPI and bar number as composite identifiers to enforce a single active listing per attorney.

7.8 No Identification of Opposing Counsel

The Services do not identify, profile, or otherwise surface information concerning opposing counsel for any User's matter. Listed Lawyers are surfaced in their professional capacity as marketplace participants, not as adversaries to identified parties.

7.9 State-by-State Operation

The lawyer marketplace operates only in jurisdictions where Candid has determined that operation complies with applicable lawyer referral, advertising, and consumer protection rules. Candid may add, remove, or modify operations in any jurisdiction at any time. Users in unsupported jurisdictions may experience reduced functionality.

7.10 No Malpractice Insurance Information

Candid does not collect, verify, or display attorney professional liability ("malpractice") insurance information for Listed Lawyers. The presence or absence of malpractice insurance, the identity of any insurance carrier, the limits of any policy, and any related coverage details are NOT represented, vetted, or disclosed by Candid through the Services.

Users seeking information about a Listed Lawyer's malpractice insurance coverage are responsible for obtaining that information directly from the Lawyer prior to engagement. Many states require lawyers to disclose malpractice insurance status to prospective clients pursuant to state bar rules; this is a Lawyer-to-client obligation governed by applicable bar rules, not a Candid-to-User obligation. Users should ask Listed Lawyers directly about insurance coverage during consultations or as part of their independent due diligence.

The absence of malpractice insurance information on Candid is by design. Candid Case is a marketplace where Users connect with Listed Lawyers for their own evaluation and engagement. Users assume the burden of vetting Listed Lawyers, including without limitation evaluating their professional credentials, experience, fees, references, malpractice coverage, and any other factor material to engagement. Candid's verification activities are limited to those expressly described in Section 7.6 (state bar admission and disciplinary status); no other verification or representation is made by Candid concerning Listed Lawyers.

7.11 User Responsibility for Diligence

Without limiting any other provision, Users acknowledge and agree that:

(a) Candid is a marketplace, not a vetting service;
(b) Listed Lawyer profile information beyond state bar admission and disciplinary status (Section 7.6) is Self-Reported by the Lawyer and not independently verified by Candid;
(c) Users are solely responsible for evaluating Listed Lawyer suitability before engaging the Lawyer for legal services, and for conducting any additional verification (including malpractice insurance, fee structure, credentials, references) the User deems material; and
(d) Engagement of a Listed Lawyer is a separate transaction between the User and the Lawyer, and Candid is not a party to that engagement, nor responsible for any aspect of the Lawyer's services or conduct following engagement.

8. SUBSCRIPTION, FEES, AND BILLING

8.1 Free and Paid Tiers

Candid offers free and paid tiers of service. Free-tier features include the Candid Claim audit engine, the Candid Plan benefit analysis, and access to the Candid Case marketplace and small claims preparation. Paid-tier features (Candid Pro) include but are not limited to dispute letter generation, premium Candid Care features, and other features identified at sign-up.

8.2 Recurring Billing

Paid subscriptions are recurring and billed on a monthly basis (or other interval disclosed at sign-up) until canceled. By providing payment information and subscribing, you authorize Candid (through its payment processor, Stripe, Inc.) to charge the applicable subscription fee to your designated payment method on each billing date.

8.3 Payment Methods; Stripe

Candid uses Stripe, Inc. for payment processing. Your payment card information is stored by Stripe, not by Candid. Candid retains only display fields (last four digits, card brand, expiration). Use of Stripe is subject to Stripe's terms of service (https://stripe.com/legal/ssa).

8.4 Cancellation; Period-End Cancellation

You may cancel your paid subscription at any time through the Billing page (https://www.candidclaim.com/billing). Cancellation takes effect at the end of the then-current billing period; you retain access to paid features until the period closes. Candid does not provide pro-rata refunds for unused portions of a billing period.

8.5 Fee Changes

Candid may modify subscription fees with thirty (30) days' written notice. Continued subscription after the effective date constitutes acceptance of the new fee. You may cancel before the new fee takes effect to avoid the change.

8.6 No Refunds

Except as required by applicable law or as expressly stated in these Terms, all fees paid are non-refundable.

8.7 Lawyer Marketplace Fees

Listed Lawyers' marketplace fees are governed by separate agreements between Candid and each Listed Lawyer and are not the subject of these Terms.

9. INTELLECTUAL PROPERTY; COPYRIGHT; DMCA

9.1 Candid's Intellectual Property

The Services, including all software, designs, text, graphics, audio, video, photographs, logos, trademarks, and other content created by Candid (collectively, the "Candid IP"), are the property of Candid or its licensors and are protected by United States and international copyright, trademark, patent, trade secret, and other intellectual property laws.

You are granted a limited, non-exclusive, non-transferable, revocable license to access and use the Services solely as expressly permitted by these Terms. Except as expressly authorized, you may not copy, reproduce, modify, distribute, sell, license, sublicense, transfer, publicly display, publicly perform, transmit, or otherwise exploit Candid IP.

9.2 User Content License

The license you grant Candid in your User Submissions is set forth in Section 6.1.

9.3 DMCA Copyright Policy

Candid complies with the Digital Millennium Copyright Act ("DMCA"). If you believe that Content on the Services infringes your copyright, you may submit a DMCA takedown notice to Candid's designated DMCA agent.

9.3.1 Designated DMCA Agent

DMCA notices must be sent to:

   Airgetlam Labs LLC, Legal Department
   Designated DMCA Agent
   7547 Leviston Avenue
   El Cerrito, CA 94530
   Email: legal@candidclaim.com

9.3.2 DMCA Notice Requirements

A valid DMCA notice must include:

(a) a physical or electronic signature of the copyright owner or authorized agent;
(b) identification of the copyrighted work claimed to have been infringed;
(c) identification of the allegedly infringing Content with sufficient detail (URL or location) to permit Candid to locate it;
(d) sufficient contact information for the complainant;
(e) a statement that the complainant has a good-faith belief that the use is not authorized by the copyright owner, agent, or law; and
(f) a statement, under penalty of perjury, that the information in the notice is accurate and that the complainant is authorized to act on behalf of the copyright owner.

9.3.3 Counter-Notification

If your Content has been removed or disabled in response to a DMCA notice, you may submit a counter-notification containing the information required by 17 U.S.C. § 512(g)(3). Upon receipt of a valid counter-notification, Candid may restore the Content unless the complainant initiates a court action within 10-14 business days.

9.3.4 Repeat Infringer Policy

Candid will terminate, in appropriate circumstances, the accounts of Users who are repeat copyright infringers.

9.4 Trademark Notices

If you believe that Content on the Services infringes a trademark you own, please contact us at legal@candidclaim.com with relevant details. While trademark complaints are not subject to the DMCA, Candid reviews them in good faith.

10. HEALTHCARE-SPECIFIC PROVISIONS

10.1 No Medical Advice

The Services do not provide medical advice. Information about healthcare providers, procedures, costs, and quality is informational only and is not a substitute for professional medical advice, diagnosis, or treatment. Always seek the advice of a licensed physician or other qualified healthcare provider with any questions about a medical condition.

10.2 Cost Information Is Not a Quote

Pricing information surfaced through Candid Care, including median costs, ranges, percentiles, and Medicare benchmarks, is informational only and is not a quote, offer, or guarantee. Actual costs may vary significantly based on the User's insurance plan, plan year, deductible status, individual provider negotiations, and other factors. Users should confirm costs directly with the provider before receiving care.

10.3 No Endorsement of Providers

The presence or absence of any healthcare provider in Candid Care does not constitute endorsement, recommendation, or warranty by Candid. Provider selection is the User's decision based on the User's own circumstances and judgment.

10.4 Document Uploads; Protected Health Information

If you upload medical bills, Explanations of Benefits, Summary of Benefits and Coverage documents, or other documents that may contain Protected Health Information ("PHI") as defined under HIPAA, you authorize Candid to process such documents for purposes of providing the Services. You are solely responsible for redacting any PHI of third parties (such as dependents) from uploaded documents to the extent appropriate. Candid's handling of PHI is described in detail in our Privacy Policy (https://www.candidclaim.com/privacy).

10.5 No Warranty of Audit Accuracy

The Candid Claim audit engine surfaces potential billing errors based on rule-based and aggregate-data heuristics. Audit findings are informational and do not guarantee the existence of an actual billing error. Users are responsible for evaluating audit findings, consulting with healthcare providers and insurers, and determining whether to take any action.

10.6 No Insurance Brokerage

Candid is not a licensed insurance broker, agent, or advisor in any jurisdiction. Information about insurance plans, supplemental insurance, alternative plans, or related products is informational only. Users should consult licensed insurance professionals before making coverage decisions.

11. LEGAL-SERVICES-SPECIFIC PROVISIONS

11.1 No Legal Advice

The Services do not provide legal advice. Candid is not a law firm and does not engage in the practice of law. Information provided through the Services, including dispute letter templates, audit findings, case files, small claims preparation, marketplace match descriptions, and any other content, is informational only and is not a substitute for advice from a licensed attorney.

11.2 User Sends All Letters

Dispute letters, negotiation letters, and any other correspondence generated through the Services are drafted for the User and must be sent by the User. Candid does not transmit, file, or submit any document to any insurer, healthcare provider, court, regulator, or other party on the User's behalf. The User is solely responsible for sending all communications.

11.3 Credit Repair Organizations Act (CROA)

Candid is not a "credit repair organization" as defined in the Credit Repair Organizations Act, 15 U.S.C. § 1679a, and the Services are not "credit repair services" or analogous services regulated under that statute or analogous state laws. The Services do not modify or improve any consumer credit record, history, rating, or score. Medical bill disputes are addressed to insurers and healthcare providers, not to credit bureaus or collection agencies.

To the extent any portion of the Services is alleged to fall within CROA or analogous state laws, Users acknowledge and agree that:

(a) they are not required to pay for any portion of the Services in advance of completion of services they performed (the User performs the dispute themselves; Candid provides information services only);
(b) Candid does not make claims about the User's credit score or rating;
(c) the User has the right to cancel any contract for credit repair services within three (3) business days, and any such right is hereby preserved.

11.4 Small Claims Preparation Is Not Legal Advice

Information about state-by-state small claims procedures, filing fees, jurisdictional thresholds, and court forms is publicly sourced and informational. Candid does not provide legal advice regarding small claims actions. Users contemplating legal action should consult an attorney.

11.5 Case Files Are User Property

Case files generated through the Services compile information provided by the User and from public and aggregate sources for the User's own use. Case files are the User's property. Candid does not warrant the accuracy, completeness, or legal sufficiency of any case file for any specific legal proceeding.

12. DISCLAIMERS AND WARRANTIES

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE SERVICES ARE PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, AND ANY WARRANTIES ARISING FROM COURSE OF DEALING OR USAGE OF TRADE.

WITHOUT LIMITING THE FOREGOING, CANDID DOES NOT WARRANT THAT:

(a) THE SERVICES WILL MEET THE USER'S REQUIREMENTS;
(b) THE SERVICES WILL BE UNINTERRUPTED, TIMELY, SECURE, OR ERROR-FREE;
(c) ANY INFORMATION OBTAINED THROUGH THE SERVICES WILL BE ACCURATE, COMPLETE, OR RELIABLE;
(d) DEFECTS IN THE SERVICES WILL BE CORRECTED;
(e) THE SERVICES OR THE SERVERS THAT MAKE THEM AVAILABLE ARE FREE FROM VIRUSES OR OTHER HARMFUL COMPONENTS; OR
(f) ANY DISPUTE LETTER, AUDIT FINDING, MATCH RECOMMENDATION, OR OTHER OUTPUT WILL ACHIEVE ANY PARTICULAR RESULT.

SOME JURISDICTIONS DO NOT ALLOW EXCLUSION OF CERTAIN WARRANTIES; THE LIMITATIONS IN THIS SECTION 12 APPLY ONLY TO THE EXTENT PERMITTED BY APPLICABLE LAW.

13. LIMITATION OF LIABILITY

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, CANDID, AIRGETLAM LABS LLC, AND THEIR RESPECTIVE OFFICERS, DIRECTORS, EMPLOYEES, AGENTS, AFFILIATES, AND LICENSORS (COLLECTIVELY, "CANDID PARTIES") SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, INCLUDING BUT NOT LIMITED TO DAMAGES FOR LOSS OF PROFITS, GOODWILL, USE, DATA, OR OTHER INTANGIBLE LOSSES, ARISING FROM OR RELATED TO YOUR USE OF OR INABILITY TO USE THE SERVICES, REGARDLESS OF THE THEORY OF LIABILITY (CONTRACT, TORT, NEGLIGENCE, STRICT LIABILITY, OR OTHERWISE) AND EVEN IF CANDID PARTIES HAVE BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE TOTAL CUMULATIVE LIABILITY OF CANDID PARTIES TO YOU FOR ALL CLAIMS ARISING FROM OR RELATED TO THESE TERMS OR THE SERVICES SHALL NOT EXCEED THE GREATER OF: (A) THE TOTAL AMOUNTS PAID BY YOU TO CANDID IN THE TWELVE (12) MONTHS PRECEDING THE CLAIM, OR (B) ONE HUNDRED U.S. DOLLARS ($100).

SOME JURISDICTIONS DO NOT ALLOW THE EXCLUSION OR LIMITATION OF CERTAIN DAMAGES; THE LIMITATIONS IN THIS SECTION 13 APPLY ONLY TO THE EXTENT PERMITTED BY APPLICABLE LAW.

The limitations in this Section 13 apply regardless of whether any limited remedy provided in these Terms fails of its essential purpose.

14. INDEMNIFICATION

You agree to indemnify, defend, and hold harmless Candid Parties (as defined in Section 13) from and against any and all claims, demands, lawsuits, damages, liabilities, losses, judgments, settlements, costs, and expenses (including reasonable attorneys' fees and court costs) arising out of or relating to:

(a) your access to or use of the Services;
(b) your violation of these Terms or the Community Guidelines;
(c) your violation of any rights of any third party, including but not limited to defamation, intellectual property, privacy, or publicity rights;
(d) your User Submissions (including without limitation any claim that a User Submission is defamatory, infringing, false, misleading, or unlawful);
(e) your violation of any applicable law or regulation; or
(f) any misrepresentation or breach of any of your representations and warranties under these Terms.

Candid reserves the right, at its own expense, to assume the exclusive defense and control of any matter for which you are required to indemnify Candid, in which case you agree to cooperate with Candid's defense. You shall not settle any matter affecting Candid without Candid's prior written consent.

15. TERMINATION

15.1 Termination by Candid

Candid may suspend, restrict, or terminate your access to the Services, in whole or in part, at any time, with or without notice, for any reason, including but not limited to:

(a) breach of these Terms;
(b) violation of the Community Guidelines;
(c) fraud, misrepresentation, or other unlawful conduct;
(d) extended inactivity;
(e) regulatory or legal requirement; or
(f) at Candid's sole discretion.

15.2 Termination by You

You may terminate your account at any time as described in Section 4.3.

15.3 Effect of Termination

Upon termination:

(a) your right to access the Services ceases;
(b) Candid may delete or archive your account and User Submissions, subject to retention obligations under Section 6.7 and applicable law;
(c) any outstanding payment obligations survive;
(d) the provisions specified in Section 20.5 survive.

16. MODIFICATIONS TO TERMS

Candid may modify these Terms at any time. Material modifications will be communicated to Users by:

(a) updating the "Last Revised" date at the top of these Terms;
(b) posting the modified Terms on the Services; and
(c) for material changes, providing notice through email or in-platform notification at least thirty (30) days before the effective date.

Material changes to the dispute resolution provisions in Section 17 (arbitration agreement, class action waiver, governing law, venue) require your express acceptance, which may be obtained through an in-platform consent flow. If you do not accept material changes to dispute resolution provisions, you may terminate your account before the changes take effect.

For all other modifications, your continued use of the Services after the effective date of the modifications constitutes your acceptance of the modified Terms. If you do not agree to any modifications, you must stop using the Services and may terminate your account.

17. DISPUTE RESOLUTION; ARBITRATION; CLASS ACTION WAIVER

PLEASE READ THIS SECTION 17 CAREFULLY. IT REQUIRES YOU AND CANDID TO RESOLVE DISPUTES THROUGH BINDING INDIVIDUAL ARBITRATION RATHER THAN COURT, AND IT WAIVES YOUR RIGHT TO PARTICIPATE IN A CLASS ACTION.

17.1 Informal Resolution

Before initiating arbitration, you and Candid agree to first attempt to resolve any dispute informally for at least sixty (60) days. To begin informal resolution, you must send a written notice describing the dispute to legal@candidclaim.com with the subject line "Dispute Notice." Candid will respond within thirty (30) days.

17.2 Binding Arbitration

If the dispute is not resolved through informal resolution, you and Candid agree that any dispute, claim, or controversy arising out of or relating to these Terms or the Services (including the formation, breach, termination, validity, or enforceability of these Terms) shall be resolved by binding individual arbitration administered by JAMS in accordance with its applicable rules then in effect.

The arbitration shall be conducted by a single arbitrator. Hearings, if any, will be conducted by videoconference unless the parties agree otherwise. The arbitrator's decision is final and binding, subject only to limited judicial review under the Federal Arbitration Act, 9 U.S.C. § 1 et seq.

17.3 Class Action Waiver

YOU AND CANDID AGREE THAT EACH MAY BRING CLAIMS AGAINST THE OTHER ONLY IN AN INDIVIDUAL CAPACITY AND NOT AS A PLAINTIFF OR CLASS MEMBER IN ANY PURPORTED CLASS, COLLECTIVE, REPRESENTATIVE, OR PRIVATE ATTORNEY GENERAL PROCEEDING. THE ARBITRATOR MAY NOT CONSOLIDATE OR JOIN MORE THAN ONE PERSON'S CLAIMS WITHOUT THE PARTIES' EXPRESS WRITTEN CONSENT AND MAY NOT PRESIDE OVER ANY FORM OF REPRESENTATIVE OR CLASS PROCEEDING.

If a court or arbitrator finds that the class action waiver in this Section 17.3 is unenforceable for any reason, then the entirety of Section 17 (arbitration agreement) shall be null and void, but the remainder of these Terms shall continue in full force and effect.

17.4 Right to Opt Out of Arbitration

YOU MAY OPT OUT OF THE ARBITRATION AGREEMENT IN THIS SECTION 17 BY SENDING WRITTEN NOTICE TO legal@candidclaim.com WITHIN THIRTY (30) DAYS AFTER FIRST ACCEPTING THESE TERMS, WITH THE SUBJECT LINE "ARBITRATION OPT-OUT" AND INCLUDING YOUR FULL NAME AND ACCOUNT EMAIL. If you opt out, you and Candid will resolve disputes in court as described in Section 18, but you remain bound by the class action waiver if it is enforceable in court.

17.5 Exceptions

Notwithstanding Section 17.2, either party may bring an action in court (subject to Section 18) for:

(a) intellectual property infringement;
(b) injunctive or equitable relief to protect intellectual property rights, confidentiality, or to prevent material harm;
(c) small claims court matters within that court's jurisdiction; or
(d) as required by applicable law (such as certain statutory actions that cannot be arbitrated).

17.6 Arbitration Costs

Each party shall bear its own arbitration costs except as required by JAMS rules or applicable law. Candid will pay arbitration filing, administration, and arbitrator fees to the extent JAMS Consumer Arbitration Minimum Standards or analogous rules require.

17.7 Arbitration Confidentiality

Arbitration proceedings shall be confidential. Neither party may disclose the existence, content, or results of any arbitration except as required by law or to enforce the arbitration award.

18. GOVERNING LAW; VENUE

These Terms and any dispute arising out of or relating to these Terms or the Services shall be governed by and construed in accordance with the laws of the State of Delaware, without regard to its conflict of laws principles.

For any matter not subject to binding arbitration under Section 17 (including matters where the User has opted out of arbitration or matters falling within Section 17.5 exceptions), the parties consent to the exclusive jurisdiction of the state and federal courts located in New Castle County, Delaware, and waive any objection to venue therein.

This choice of law and forum applies to the maximum extent permitted by applicable consumer protection law. Some jurisdictions provide consumers with non-waivable rights to sue in their home jurisdiction; the foregoing applies only to the extent permitted by such laws.

19. STATE-SPECIFIC PROVISIONS

19.1 California Residents

19.1.1 California Civil Code § 1789.3 Notice

Pursuant to California Civil Code § 1789.3, California residents are entitled to the following consumer rights notice:

   The provider of this service is Airgetlam Labs LLC, 7547 Leviston Avenue, El Cerrito, CA 94530. To file a complaint regarding the Services or to receive further information regarding use of the Services, contact us at support@candidclaim.com or write to us at the address listed. You may also contact the Complaint Assistance Unit of the Division of Consumer Services of the California Department of Consumer Affairs, 1625 North Market Boulevard, Suite N-112, Sacramento, California 95834, or by telephone at (800) 952-5210.

19.1.2 California Subscription Disclosure

Subscriptions are governed by California Business & Professions Code § 17600 et seq. (Automatic Renewal Law). You will be provided clear disclosure of subscription terms at the point of sale, sent confirmation of your subscription, and given an easy method of cancellation as described in Section 8.4.

19.1.3 California Consumer Privacy

Your privacy rights under the California Consumer Privacy Act (CCPA) and California Privacy Rights Act (CPRA) are described in our Privacy Policy (https://www.candidclaim.com/privacy).

19.2 New York Residents

The arbitration provisions in Section 17 are subject to the requirements of New York General Obligations Law § 5-1401 and analogous law. New York residents may have additional consumer protection rights described in our Privacy Policy (https://www.candidclaim.com/privacy).

19.3 Massachusetts Residents

The arbitration provisions in Section 17 do not apply to claims under Massachusetts General Laws Chapter 93A (Consumer Protection Act) to the extent that statute prohibits binding arbitration of such claims.

19.4 Other Jurisdictions

Where these Terms conflict with non-waivable consumer protection rights in any jurisdiction, the non-waivable rights shall prevail to the minimum extent necessary, and the remainder of these Terms shall remain in full force and effect.

19.5 International Users

The Services are operated from and intended for use within the United States. If you access the Services from outside the United States, you do so at your own risk and are responsible for compliance with local law. If you are subject to the European Union General Data Protection Regulation (GDPR), the United Kingdom Data Protection Act, or analogous laws, please review our Privacy Policy (https://www.candidclaim.com/privacy) for applicable data subject rights.

20. GENERAL PROVISIONS

20.1 Entire Agreement

These Terms, together with the Privacy Policy (https://www.candidclaim.com/privacy), the Community Guidelines (https://www.candidclaim.com/guidelines), and any service-specific terms, constitute the entire agreement between you and Candid regarding the Services and supersede any prior or contemporaneous agreements, understandings, or representations.

20.2 Severability

If any provision of these Terms is held by a court or arbitrator of competent jurisdiction to be invalid, illegal, or unenforceable, that provision shall be modified to the minimum extent necessary to make it valid and enforceable, or, if such modification is not possible, severed from these Terms. The remaining provisions shall continue in full force and effect.

20.3 No Waiver

Failure or delay by either party in exercising any right under these Terms shall not constitute a waiver of that right. No waiver of any term shall be deemed a continuing waiver or a waiver of any other term.

20.4 Assignment

You may not assign or transfer these Terms or any rights or obligations hereunder, by operation of law or otherwise, without Candid's prior written consent. Candid may freely assign or transfer these Terms in connection with a merger, acquisition, sale of assets, or by operation of law. Any unauthorized assignment by you is null and void.

20.5 Survival

The provisions of these Terms that by their nature should survive termination shall so survive, including without limitation: Sections 5 (Platform Status), 6 (User Submissions), 9 (Intellectual Property), 12 (Disclaimers), 13 (Limitation of Liability), 14 (Indemnification), 15.3 (Effect of Termination), 17 (Arbitration), 18 (Governing Law), 20 (General Provisions), and any payment obligations.

20.6 Force Majeure

Candid shall not be liable for any failure or delay in performance arising from circumstances beyond its reasonable control, including acts of God, natural disasters, war, terrorism, civil unrest, government action, labor disputes, internet or telecommunications failures, or pandemics.

20.7 Notices

Notices to Candid must be sent to:

   Airgetlam Labs LLC
   7547 Leviston Avenue
   El Cerrito, CA 94530
   Email: legal@candidclaim.com

Notices to you may be sent via email to the address associated with your account or by posting on the Services. Notices are deemed effective upon receipt (for email) or twenty-four (24) hours after posting (for in-platform notices).

20.8 No Third-Party Beneficiaries

These Terms do not create any third-party beneficiary rights, except that Candid Parties (as defined in Section 13) are intended beneficiaries of Sections 12, 13, and 14.

20.9 Headings

Section headings are for convenience only and do not affect interpretation.

20.10 Construction

These Terms shall not be construed against either party as the drafter. The parties acknowledge that they have had the opportunity to review and consult with counsel.

20.11 Electronic Signatures and Records

You consent to the use of electronic signatures and records in connection with these Terms and the Services. You may withdraw consent by terminating your account.

20.12 Government Users

If you are a U.S. government end-user, the Services and any related documentation are "commercial items" as defined at 48 C.F.R. § 2.101, consisting of "commercial computer software" and "commercial computer software documentation." Government use is subject to these Terms.

21. CONTACT INFORMATION

Company:

   Airgetlam Labs LLC, doing business as Candid
   7547 Leviston Avenue
   El Cerrito, CA 94530
   Website: https://www.candidclaim.com

General Inquiries and Support: support@candidclaim.com
Legal Notices, DMCA, Disputes, Trademark, Arbitration Opt-Out: legal@candidclaim.com
Privacy Inquiries (CCPA, CPRA, GDPR): privacy@candidclaim.com

Candid is an Airgetlam Labs LLC company.`
  ),

  // ===========================================================================
  // #6 — PRIVACY POLICY (v1.4)
  // Covers: data categories, purposes, processors, retention, no sale,
  //         CCPA/CPRA rights (incl. GPC), WA MHMD Act rights, cookies, security, children.
  // ===========================================================================
  privacy_policy: defineConsent(
    "privacy_policy",
    "1.4",
    "2026-04-08",
    "Privacy Policy",
    "Our privacy policy explains how we collect, use, and protect your personal information.",
    `CANDID PRIVACY POLICY
Version 1.4 — Effective April 8, 2026
Operated by Airgetlam Labs LLC

1. SCOPE
This Privacy Policy describes how Airgetlam Labs LLC ("Candid," "we," "us") collects, uses, and protects your personal information when you use the Candid platform. This policy covers your account and profile data only. Collection of health-related data (medical bills, EOBs, insurance documents) is governed by a separate Health Data Consent that you must accept before uploading any health documents.

2. INFORMATION WE COLLECT

(a) Account Information — When you create an account, we collect:
- Full legal name
- Email address
- State of residence
- Authentication credentials (password hash or third-party OAuth token)

(b) Insurance Profile — When you set up your profile, you may provide:
- Insurance company name
- Plan name and type (employer, marketplace, off-exchange, Medicare, Medicaid)
- Matched plan identifier (if using CMS marketplace plan data)

(c) Usage Data — We automatically collect:
- Pages visited and features used
- Timestamps of activity
- Device type and browser type (not fingerprinted or shared)
- IP address (used for security and fraud prevention only; not shared with third parties)

(d) Support Communications — When you contact support, we retain your messages and our responses.

(e) Payment Information — Subscription payment details are collected and processed directly by Stripe, Inc. We do not store your credit card number, bank account number, or other payment instrument details on our servers. We receive from Stripe only: subscription status, billing period, and a truncated card identifier for display purposes.

(f) Email-Forwarded Documents — If you forward documents to us via email (e.g., to support@candidclaim.com), we collect: the sender's email address, email subject and body text, and any attachments. Email-forwarded documents are processed the same way as directly uploaded documents.

3. INFORMATION WE DO NOT COLLECT UNDER THIS POLICY
Health data (medical bills, EOBs, insurance documents, audit results, billing codes) is NOT covered by this Privacy Policy. Collection and use of health data requires separate, informed consent under our Health Data Consent document. This separation is required by the Washington My Health My Data Act and recommended under CCPA/CPRA for sensitive data categories.

4. HOW WE USE YOUR INFORMATION
We use your personal information to:
- Provide, maintain, and improve the Candid platform
- Authenticate your identity and secure your account
- Match you with relevant insurance plan data from public sources (CMS Marketplace API)
- Communicate with you about your account, service updates, and support requests
- Process subscription payments
- Comply with legal obligations
- Detect and prevent fraud or unauthorized access

We do NOT use your personal information for:
- Targeted advertising
- Sale to data brokers
- Profiling for credit, insurance, or employment decisions

5. THIRD-PARTY SERVICE PROVIDERS
We share limited personal data with the following service providers, each operating under data processing agreements:

| Provider | Purpose | Data Shared |
|----------|---------|-------------|
| Supabase (Supabase Inc.) | Database hosting | Account info, profile, usage records |
| Firebase / Google Cloud Platform | Authentication, file storage | Email, auth tokens, uploaded files |
| Stripe, Inc. | Payment processing | Email, subscription events |
| Resend (Resend Inc.) | Transactional email (outbound and inbound) | Email address, name, inbound email content |
| Vercel Inc. | Application hosting | IP address (server logs, auto-deleted) |
| Upstash (QStash) | Asynchronous document processing queue | Document processing job references |
| Slack (Salesforce) | Admin operational alerts | System-level alerts (no user-identifiable data) |
| Google Cloud Document AI | Document OCR and parsing | Uploaded document images (processed in-memory, not stored by Google) |

We do not share your data with advertising networks, social media platforms, or data brokers.

6. DATA RETENTION
Retention periods for each category of personal information are determined based on the following criteria: (1) whether the data is necessary to provide active services to your account, (2) applicable legal and regulatory obligations (e.g., tax, financial reporting), (3) the need to resolve disputes or enforce our agreements, and (4) the active status of your account. Specific periods:
- Account data is retained for the lifetime of your account.
- Upon account deletion, personal data is removed within 30 days.
- Server access logs (containing IP addresses) are retained for no more than 90 days.
- Payment records are retained for 7 years as required by IRS tax and financial reporting regulations.
- Support communications are retained for 2 years after resolution, then deleted.

7. WE DO NOT SELL YOUR DATA
Candid does not sell, rent, or trade your personal information to third parties. This applies to all categories of personal information we collect. For the purposes of the California Consumer Privacy Act (CCPA/CPRA), we confirm: we have not sold personal information in the preceding 12 months and do not intend to do so.

8. COOKIES AND TRACKING
Candid uses only essential, first-party cookies required for authentication and session management. We do not use:
- Third-party tracking cookies
- Advertising pixels or beacons
- Cross-site tracking technologies
- Analytics platforms that share data with third parties

9. YOUR RIGHTS — ALL USERS
Regardless of where you reside, you have the right to:
- Access: Request a copy of your personal data
- Correction: Update or correct inaccurate personal data
- Deletion: Request deletion of your account and personal data
- Portability: Request your data in a structured, machine-readable format
To exercise these rights, visit your account Settings page or submit a support ticket.

10. YOUR RIGHTS — CALIFORNIA RESIDENTS (CCPA/CPRA)
If you are a California resident, you have additional rights under the California Consumer Privacy Act, as amended by the California Privacy Rights Act:
- Right to Know: You may request the specific categories and pieces of personal information we have collected about you, the sources, the business purposes, and the categories of third parties with whom we share it.
- Right to Delete: You may request deletion of personal information we hold about you, subject to legal exceptions.
- Right to Correct: You may request correction of inaccurate personal information.
- Right to Opt Out of Sale/Sharing: We do not sell or share your personal information for cross-context behavioral advertising. No opt-out is necessary, but you may submit one via a support ticket for your records.
- Global Privacy Control (GPC): Candid recognizes and processes Global Privacy Control (GPC) opt-out preference signals transmitted by your web browser. When we detect a GPC signal, we treat it as a valid request to opt out of the sale or sharing of personal information associated with that browser, as required by CCPA/CPRA regulations. No additional action is required on your part.
- Right to Limit Use of Sensitive Personal Information: Your health data is governed by a separate consent. We do not use sensitive personal information for purposes beyond what is needed to provide our services.
- Non-Discrimination: We will not discriminate against you for exercising your CCPA/CPRA rights.
To submit a verifiable consumer request, visit your account Settings page or submit a support ticket. We will respond within 45 days.

11. YOUR RIGHTS — WASHINGTON STATE RESIDENTS (MY HEALTH MY DATA ACT)
If you are a Washington state resident, you have additional rights under the Washington My Health My Data Act (RCW 19.373):
- Your consumer health data (including medical billing records) requires separate, specific consent before collection — provided through our Health Data Consent document.
- You may revoke consent for health data collection at any time.
- You may request deletion of all consumer health data within 30 days.
- We will never sell your consumer health data without separate, explicit consent.
- We will never geofence healthcare facilities to collect or infer health data.
- You have a private right of action under the Washington Consumer Protection Act (RCW 19.86) if we violate these provisions.
Health data rights are exercised through the Health Data Consent document and your account Settings page.

12. CHILDREN'S PRIVACY
Candid is not intended for use by individuals under 18 years of age. We do not knowingly collect personal information from children. If we learn that we have collected data from a child under 18, we will delete it promptly.

13. INTERNATIONAL USERS
Candid is operated from the United States. If you access Candid from outside the United States, your data will be transferred to and processed in the United States. By using Candid, you consent to this transfer.

14. DATA SECURITY
We implement industry-standard security measures including:
- Encryption in transit (TLS 1.2+)
- Encryption at rest (AES-256 for stored data)
- Role-based access controls
- Authentication via Firebase with secure token management
- Regular access reviews
No system is 100% secure. We cannot guarantee absolute security but will notify affected users promptly in the event of a data breach, consistent with applicable state breach notification laws.

15. CHANGES TO THIS POLICY
We may update this Privacy Policy. Material changes will be communicated via email and will require re-acceptance. The "Effective" date at the top indicates the latest version.

16. CONTACT
Airgetlam Labs LLC
Contact us via your account Settings page or by submitting a support ticket at candidclaim.com.`
  ),

  // ===========================================================================
  // #7 — HEALTH DATA CONSENT (v1.4)
  // WA My Health My Data Act compliant: separate consent, specific categories,
  // specific purposes, named processors, retention period, revocation, deletion.
  // Also addresses CCPA/CPRA sensitive data and HIPAA non-applicability.
  // ===========================================================================
  health_data_upload: defineConsent(
    "health_data_upload",
    "1.4",
    "2026-04-08",
    "Health Data Consent",
    "Separate consent required before uploading medical bills, EOBs, or other health-related documents.",
    `CANDID HEALTH DATA CONSENT
Version 1.4 — Effective April 8, 2026
Operated by Airgetlam Labs LLC

IMPORTANT: This is a SEPARATE consent from the Terms of Service and Privacy Policy. Under the Washington My Health My Data Act (RCW 19.373) and the California Consumer Privacy Act (CCPA/CPRA), your medical billing data is classified as sensitive consumer health data requiring specific, informed consent before collection. You must accept this consent before uploading any health-related documents to Candid.

1. CATEGORIES OF HEALTH DATA COLLECTED
When you upload documents to Candid, we may collect and process the following categories of consumer health data:
- Medical bills and itemized hospital bills (provider names, dates of service, charge amounts)
- Explanation of Benefits (EOB) documents (insurer determinations, allowed amounts, patient responsibility)
- Insurance statements and Summary of Benefits and Coverage (SBC) documents
- Insurance card images (member ID, group number, plan identifiers, insurer contact information)
- Claims data and billing line items (claim numbers, adjudication details, per-charge amounts, adjustment reason codes)
- Procedure codes (CPT, HCPCS) and diagnosis codes (ICD-10) extracted from your documents
- Provider names, facility names, and National Provider Identifiers (NPIs) from your documents
- Charge amounts, payment amounts, adjustment amounts, and balance-due amounts
- Dispute records (generated letter drafts, dispute status, correspondence tracking)
We do NOT collect or store: Social Security numbers, medical record numbers, clinical notes, lab results, or diagnostic images. We do NOT collect individual prescription fill records or pharmacy history. We DO extract plan formulary information (which drug categories your plan covers and at what tier) from plan documents — this describes your plan's drug coverage structure, not your personal prescriptions. If such information appears in uploaded documents, we do not extract or retain it.

2. SPECIFIC PURPOSES FOR WHICH YOUR HEALTH DATA IS USED
Your uploaded health documents will be used exclusively for:
(a) Bill Parsing — Extracting structured billing data (provider, codes, charges, adjustments) from your uploaded documents using optical character recognition (OCR) and document analysis.
(b) Audit Analysis — Comparing your charges against public pricing benchmarks (CMS Medicare Physician Fee Schedule, published hospital price transparency files) to identify potential overcharges, billing errors, unbundling violations, upcoding, and duplicate charges.
(c) Benefit Matching — Comparing procedures on your bills against your insurance plan's covered benefits to identify coverage gaps or missed in-network savings.
(d) Dispute Letter Generation — Populating dispute letter templates with facts extracted from your documents, including provider names, dates, codes, and charge amounts. You review and send all letters yourself.
(e) Cost Estimation — Displaying price comparison estimates for your specific procedures across providers in your area.
(f) Plan Catalog Improvement — Contributing extracted plan structure data (benefits, cost-sharing terms, formulary tiers) to a de-identified canonical plan database. This improves benefit matching accuracy for all users with similar plans. Individual user identity is never associated with canonical plan records.
Your health data will NOT be used for any purpose not listed above without obtaining separate, additional consent.

3. THIRD-PARTY PROCESSORS WHO ACCESS YOUR HEALTH DATA
The following service providers may process your health data under strict data processing agreements:

| Processor | Purpose | Data Accessed |
|-----------|---------|---------------|
| Google Cloud Platform (Document AI) | OCR and document parsing | Uploaded document images (processed, not stored by Google beyond processing) |
| Supabase (Supabase Inc.) | Encrypted database storage | Extracted billing data, audit results |
| Firebase / Google Cloud Storage | Encrypted file storage | Original uploaded document files |
| Upstash (QStash) | Asynchronous document processing queue | Document processing job references (not document content) |

No other third party receives, accesses, or processes your identifiable health data. We do not share your health documents with advertisers, data brokers, insurers, providers, employers, or any other party.

4. DATA RETENTION AND STORAGE
- Your uploaded documents and extracted data are retained for the lifetime of your account or until you delete them, whichever comes first.
- Upon consent revocation, all uploaded documents and extracted health data are deleted within 30 days.
- Upon account deletion, all health data is deleted within 30 days.
- Encrypted backups that may contain health data are purged within 90 days of deletion.
- Health data is encrypted at rest (AES-256) and in transit (TLS 1.2+).

5. WHAT THIS CONSENT DOES NOT AUTHORIZE
This consent does NOT authorize:
- Sale of your identifiable health data to any third party — ever
- Sharing your documents or extracted data with insurers, providers, employers, or other users
- Use of your health data for advertising, marketing, or profiling
- Use of your health data for purposes other than those listed in Section 2
- Geofencing of healthcare facilities to collect or infer health data about you
If we wish to use your data for additional purposes (such as anonymized aggregate research), we will request separate, additional consent at that time.

6. YOUR RIGHT TO REVOKE CONSENT
You may revoke this health data consent at any time. Revoking consent will:
- Immediately prevent further processing of your uploaded documents
- Queue all uploaded documents and extracted health data for deletion within 30 days
- Preserve your account, subscription, and non-health personal data
- Not affect the legality of processing performed before revocation
To revoke, visit your account Settings page and select "Revoke Health Data Consent," or submit a support ticket.

7. YOUR RIGHT TO DELETE
Under the Washington My Health My Data Act and CCPA/CPRA, you have the right to request deletion of all consumer health data we hold about you. Upon receiving a verified deletion request, we will:
- Delete all uploaded documents from file storage within 30 days
- Delete all extracted billing data, audit results, and dispute letter drafts within 30 days
- Confirm deletion to you in writing
To request deletion, visit your account Settings page and select "Delete My Account," or submit a support ticket with the subject "Health Data Deletion Request."

8. YOUR RIGHT TO ACCESS
You may request a copy of all health data we hold about you. We will provide it in a structured, machine-readable format (JSON or CSV) within 30 days.

9. HIPAA NOTICE
Candid is not a healthcare provider, health plan, healthcare clearinghouse, or Business Associate as defined under the Health Insurance Portability and Accountability Act (HIPAA). When you upload your own medical documents to Candid, you are exercising your right to access, use, and share your own health information as a consumer.
While HIPAA does not directly regulate Candid, we voluntarily adopt security practices consistent with the HIPAA Security Rule as a best-practice standard for protecting your health data. See our HIPAA Storage Practices documentation for details.

10. CANDID IS NOT A HEALTHCARE PROVIDER
Candid does not provide medical advice, diagnoses, treatment recommendations, or clinical opinions. All health-related outputs (audit findings, benefit analyses, cost estimates) are informational tools for your independent use. Always consult qualified healthcare and legal professionals for advice specific to your situation.

11. WASHINGTON STATE RESIDENTS — ADDITIONAL RIGHTS
Under the My Health My Data Act, Washington residents have the right to:
- Receive this consent in a clear, standalone format (separate from Terms of Service)
- Know the specific categories of health data collected and each purpose for collection
- Know the specific categories of third parties and affiliates with whom health data is shared
- Revoke consent and have health data deleted within 30 days
- Bring a private cause of action under the Washington Consumer Protection Act (RCW 19.86) for violations
This consent document is designed to satisfy all requirements of RCW 19.373.

12. CONTACT
For questions about this Health Data Consent or to exercise your rights:
Airgetlam Labs LLC
Contact us via your account Settings page or by submitting a support ticket at candidclaim.com.`
  ),

  // ===========================================================================
  // MARKETPLACE DATA SHARING CONSENT (v1.4)
  // Replaces placeholder with real consent for when marketplace features launch.
  // Includes CCPA/MHMDA "sale" disclosure per legal review.
  // ===========================================================================
  marketplace_data_sharing: defineConsent(
    "marketplace_data_sharing",
    "1.4",
    "2026-04-08",
    "Marketplace Data Sharing",
    "Consent to share limited profile data with marketplace service providers when using Candid Case or Candid Care.",
    `CANDID MARKETPLACE DATA SHARING CONSENT
Version 1.4 — Effective April 8, 2026
Operated by Airgetlam Labs LLC

This consent is required before using Candid's marketplace features (Candid Case attorney directory and Candid Care provider listings). This is a SEPARATE consent from the Terms of Service, Privacy Policy, and Health Data Consent.

1. WHAT DATA IS SHARED
When you use marketplace features, the following profile-level data may be shared with listed service providers:
- Your state of residence
- Your insurance company and plan type (e.g., "BlueCross PPO")
- The general category of service you are seeking (e.g., "billing dispute attorney," "physical therapy")
- Your preferred contact method (email only — we never share your phone number)

2. WHAT IS NEVER SHARED
The following data is NEVER shared with marketplace participants:
- Your uploaded medical documents, bills, or EOBs
- Audit results, dispute letters, or extracted billing data
- Your full name (unless you choose to provide it directly to a provider)
- Your payment information
- Your usage history or activity on Candid

3. WHO RECEIVES YOUR DATA
Marketplace participants include:
(a) Attorneys listed in the Candid Case directory who specialize in healthcare billing disputes
(b) Health service providers listed in Candid Care (e.g., physical therapists, nutritionists, HSA/FSA-eligible providers)
(c) Insurance companies or brokers offering alternative or supplemental plan options
All marketplace participants operate under flat-fee listing agreements with Candid. We do not charge per-referral fees or receive commissions based on your interactions with them.

4. PURPOSE AND LEGAL DISCLOSURE
Data sharing is used exclusively for service matching — connecting you with relevant professionals based on your location, insurance, and service needs. We do not use marketplace data for advertising, profiling, or any purpose other than facilitating the connection you requested.
IMPORTANT LEGAL NOTICE: Because marketplace participants pay Candid a listing fee, sharing your profile data to facilitate a connection may be considered a "sale" of personal information under the California Consumer Privacy Act (CCPA/CPRA) and a "sale" of consumer health data under the Washington My Health My Data Act (RCW 19.373) if your insurance type is included. By accepting this consent, you explicitly authorize this specific exchange of data for the purpose of service matching. You may revoke this authorization at any time (see Section 5).

5. YOUR RIGHT TO REVOKE
You may revoke this consent at any time. Revoking consent will:
- Immediately prevent further data sharing with marketplace participants
- Disable your access to Candid Case and Candid Care marketplace features
- Not affect data already shared with providers you previously contacted
- Preserve your account and all other features (audit, benefits analysis, dispute letters)
To revoke, visit your account Settings page or submit a support ticket.

6. CONTACT
Airgetlam Labs LLC
Contact us via your account Settings page or by submitting a support ticket at candidclaim.com.`
  ),

  // ===========================================================================
  // #9 — AGGREGATE DATA RESEARCH CONSENT (v1.4)
  // Replaces placeholder. Covers de-identification methodology, what's included
  // and excluded, right to opt out, no impact on features.
  // ===========================================================================
  aggregate_data_monetization: defineConsent(
    "aggregate_data_monetization",
    "1.4",
    "2026-04-08",
    "Aggregate Data Research",
    "Consent to include your anonymized, de-identified data in aggregate research datasets.",
    `CANDID AGGREGATE DATA RESEARCH CONSENT
Version 1.4 — Effective April 8, 2026
Operated by Airgetlam Labs LLC

This consent is SEPARATE from all other Candid consents (Terms of Service, Privacy Policy, Health Data Consent, and Marketplace Data Sharing). Declining this consent will NOT affect your access to any Candid feature.

1. WHAT THIS CONSENT AUTHORIZES
By accepting this consent, you authorize Candid to include data derived from your uploaded documents in anonymized, de-identified, aggregate research datasets. These datasets power the Candid Care price transparency tool and may be made available to researchers, journalists, policymakers, and consumer advocacy organizations working to improve healthcare pricing transparency.

2. DE-IDENTIFICATION METHODOLOGY
Before any data is included in aggregate datasets, it is de-identified using the HIPAA Safe Harbor method (45 CFR 164.514(b)(2)). This means ALL of the following identifiers are removed:
- Names and initials
- Dates more specific than year (date of birth, admission dates, discharge dates)
- Addresses and zip codes (reduced to first 3 digits only, or removed if population < 20,000)
- Phone numbers, email addresses, and fax numbers
- Social Security numbers and medical record numbers
- Health plan beneficiary numbers
- Account numbers and certificate/license numbers
- Device identifiers, vehicle identifiers, and serial numbers
- Web URLs, IP addresses, and biometric identifiers
- Full-face photographs
- Any other unique identifying number or code

3. WHAT IS INCLUDED IN AGGREGATE DATASETS
Only statistical aggregates derived from many users' de-identified data, such as:
- Average, median, and range of charges for a given procedure code in a geographic region
- Frequency of specific billing patterns (e.g., unbundling rates by provider type)
- Insurance plan coverage statistics (e.g., "X% of PPO plans cover this benefit")
- Price variation indices across facilities and regions

4. WHAT IS NEVER INCLUDED
Your individual identity, documents, and personal information are NEVER included. Specifically:
- Your name, email, or any account information
- Your individual bills, EOBs, or uploaded documents
- Any data that could reasonably be used to identify you
- Your audit results, dispute letters, or case history

5. HOW AGGREGATE DATA IS USED
Aggregate datasets may be used for:
(a) Powering the Candid Care price transparency tool for all users
(b) Published research reports on healthcare pricing trends
(c) Licensed access by researchers, journalists, and advocacy organizations. Licensed access may involve fees paid to Candid by research institutions. Revenue from aggregate data licensing is used to improve the platform and is never tied to individual user data.
(d) Public policy analysis and regulatory submissions
Aggregate data is NEVER used for: targeted advertising, individual credit or insurance decisions, employer screening, or law enforcement purposes.

6. SAFEGUARDS
Minimum aggregation threshold: No statistic or data point is displayed unless it represents data from at least 5 distinct users. This k-anonymity floor prevents individual identification through small-sample inference.

7. YOUR RIGHT TO OPT OUT
You may revoke this consent at any time. Revoking consent will:
- Exclude your data from future aggregate dataset updates
- Not remove your previously contributed data from datasets already published or distributed (because it is de-identified and cannot be traced back to you)
- Not affect your access to any Candid feature
To revoke, visit your account Settings page or submit a support ticket.

8. COMPENSATION
You will not receive financial compensation for data included in aggregate datasets. The benefit to you is improved price transparency data within the Candid Care tool, which all users share.

9. CONTACT
Airgetlam Labs LLC
Contact us via your account Settings page or by submitting a support ticket at candidclaim.com.`
  ),
};

/** Get the current consent document for a given type. */
export function getConsentDocument(type: ConsentType): ConsentDocument {
  return CONSENT_DOCUMENTS[type];
}

/** Get all consent types required at a specific trigger point. */
export function getRequiredConsents(
  trigger: "signup" | "upload" | "marketplace" | "data_monetization"
): ConsentType[] {
  switch (trigger) {
    case "signup":
      return ["tos", "privacy_policy"];
    case "upload":
      return ["health_data_upload"];
    case "marketplace":
      return ["marketplace_data_sharing"];
    case "data_monetization":
      return ["aggregate_data_monetization"];
  }
}
