#!/usr/bin/env python3
"""
build-gt.py — Phase 0 GT builder (Steps 2+3)

Normalizes 6 ecm docs + independently extracts services from 2 Clarity SBCs.
Writes gt.json (GtService[]) + adjudication-worksheet.tsv + gt-sample-manifest.json.

Independence gate: does NOT call process-plan.ts or any production parser.
All slug proposals are validated against catalog.json.
"""

import json, re, random, sys
from pathlib import Path
from collections import defaultdict

FREEZE_DIR = Path("/Users/andrewullmann/Desktop/du_weldenvarden/04_Professional/Airgetlam Labs LLC/Candid/plans/findings/thesaurus-baseline-2026-06-03")
ECM_DIR = Path("/Users/andrewullmann/Desktop/du_weldenvarden/04_Professional/Airgetlam Labs LLC/Candid/plans/findings/extraction-recall-2026-06-02/gt")

catalog_path = FREEZE_DIR / "catalog.json"
catalog = json.loads(catalog_path.read_text())
VALID_SLUGS = {row["slug"] for row in catalog}

# ── Canonical plan ID mapping (verified above) ────────────────────────────────
ECM_CANONICAL = {
    "ecm":    {"canonicalPlanId": "359062ce-fdb8-4145-a5f7-bdf59c50ee97", "insurer": "Kaiser Permanente"},
    "ecm-2":  {"canonicalPlanId": "095c07f8-fc78-47fb-b03b-43f8e1e16c8e", "insurer": "Kaiser Permanente"},
    "ecm-6":  {"canonicalPlanId": "2ab6d5c9-8d75-4751-8dff-019252530e7b", "insurer": "Blue Shield of California"},
    "ecm-8":  {"canonicalPlanId": "8358552c-777b-42d3-881e-897dc24e107f", "insurer": "Anthem Blue Cross"},
    "ecm-9":  {"canonicalPlanId": "616bfca6-e837-434b-9ab4-e7242480f70a", "insurer": "Blue Shield of California"},
    "ecm-10": {"canonicalPlanId": "dcbfe17d-2f62-46ad-a9f6-b114f06ae941", "insurer": "Anthem Blue Cross"},
}

CLARITY_META = {
    "clarity-gold-2000": {
        "canonicalPlanId": "02f66f19-8d90-451b-9f35-c402ea6572e0",
        "insurer": "WellSense Health Plan",
        "pdfPath": "/Users/andrewullmann/Desktop/SBC_downloads/13219NH0010001_2026_SBC_Clarity_NH_Gold_2000_01.pdf",
        "ocrPath": "/tmp/clarity-gold-ocr.txt",
        "planName": "WellSense Clarity NH Gold 2000",
    },
    "clarity-bronze-7500-hsa": {
        "canonicalPlanId": "d3b7e4b7-7a7f-4949-b1e8-9642b360e94d",
        "insurer": "WellSense Health Plan",
        "pdfPath": "/Users/andrewullmann/Desktop/SBC_downloads/13219NH0010005_2026_SBC_Clarity_NH_Bronze_7500_HSA_01.pdf",
        "ocrPath": "/tmp/clarity-bronze-ocr.txt",
        "planName": "WellSense Clarity NH Bronze 7500 HSA",
    },
}

# ── Slug mapping rules (validated against VALID_SLUGS) ────────────────────────
# Rules applied in order; first match wins (case-insensitive substring).
# Order: specific before generic.
SLUG_RULES = [
    # ── Office visits ──────────────────────────────────────────────────────────
    ("primary care visit|pcp visit|office or clinic.*primary|family doctor|general practitioner|primary care physician", "pcp_visit"),
    ("trio.? specialist|specialist visit|physician specialist|specialist e.consult|e.consult.*specialist", "specialist_visit"),
    ("telehealth.*primary|virtual.*primary|phone.*primary care", "telehealth_pcp"),
    ("teladoc health consultation|telehealth.*general|teladoc.*general|general.*teladoc", "telehealth_pcp"),
    ("telehealth.*specialist|virtual.*specialist|teladoc.*specialist|specialist.*teladoc|teladoc.*mental", "telehealth_specialist"),
    ("telehealth|virtual visit|scheduled telephone|interactive video|video visit", "telehealth_pcp"),
    ("other practitioner office visit|other practitioner|nurse practitioner|physician assistant", "pcp_visit"),
    ("retail health clinic", "urgent_care"),
    # ── Preventive ────────────────────────────────────────────────────────────
    ("preventive health services|preventive care|preventive screening|immunization|vaccination|well-woman|well-adult|routine physical|wellness exam|well-child preventive|well.child.*preventive|tuberculosis skin test|bone density|fecal occult|routine laboratory.*screen|diagnostic.*well.*exam", "preventive_care"),
    ("annual physical|annual.*physical|well visit|well exam", "annual_physical"),
    ("cancer screen|colonoscopy|mammogram|colorectal|colon cancer|pap smear|cervical|prostate screen|psa test|screening colonoscop|screening.*sigmoidoscop", "cancer_screening"),
    # ── Emergency ─────────────────────────────────────────────────────────────
    ("emergency room|emergency care|er visit|emergency department", "er_visit"),
    ("ambulance services.water|air ambulance|air transport|helicopter", "emergency_transport_air"),
    ("ambulance services.air", "emergency_transport_air"),
    ("emergency medical transportation|emergency ambulance|ambulance transport|ambulance services.ground|ground.*ambulance", "emergency_transport_ground"),
    ("ambulance services|non-emergency ambulance|non.emergency ambulance", "emergency_transport_ground"),
    ("urgent care", "urgent_care"),
    # ── Rx: 90-day/mail-order FIRST ───────────────────────────────────────────
    ("mail order.*generic|generic.*mail order|90.day.*generic|generic.*90.day", "generic_rx_tier1_90day"),
    ("mail order.*tier.?1|tier.?1.*mail order", "generic_rx_tier1_90day"),
    ("mail order.*preferred(?!.*non)|preferred.*mail order(?!.*non)|90.day.*preferred(?!.*non)", "preferred_brand_rx_90day"),
    ("mail order.*tier.?2|tier.?2.*mail order", "preferred_brand_rx_90day"),
    ("mail order.*non.preferred|non.preferred.*mail order|90.day.*non.preferred", "non_preferred_rx_90day"),
    ("mail order.*tier.?3|tier.?3.*mail order", "non_preferred_rx_90day"),
    # Rx: chemotherapy / preventive
    ("chemotherapy drug|cancer drug|antineoplastic|oral anti-cancer|anticancer drug", "chemotherapy_rx"),
    ("certain preventive items|preventive.*prescription|preventive.*items.*pharmacy|pharmacy.*preventive", "preventive_rx"),
    # Rx: retail tiers by name
    ("generic drugs?$|generic drugs? \\$|^generic drugs?|typically generic.*tier 1|generic.*tier.?1 retail|tier.?1.*retail.*generic", "generic_rx_tier1"),
    ("preferred brand drugs?|preferred brand$|preferred brand \\$", "preferred_brand_rx_tier2"),
    ("non.preferred brand drugs?|non.preferred brand$|non.preferred brand \\$", "non_preferred_rx_tier3"),
    ("specialty drugs?|tier.?4 drug|biologic drug|pharmacy.*tier.?4|tier.?4.*pharmacy|outpatient pharmacy.*tier.?4|tier.?4.*items", "specialty_rx_tier4"),
    # Rx: retail tiers by tier number
    ("retail.*prescription.*tier.?1|tier.?1.*retail.*prescription|retail.*tier.?1|prescription.*tier.?1", "generic_rx_tier1"),
    ("retail.*prescription.*tier.?2|tier.?2.*retail.*prescription|retail.*tier.?2|prescription.*tier.?2", "preferred_brand_rx_tier2"),
    ("retail.*prescription.*tier.?3|tier.?3.*retail.*prescription|retail.*tier.?3|prescription.*tier.?3", "non_preferred_rx_tier3"),
    ("outpatient pharmacy.*tier.?1|pharmacy.*tier.?1.*item|tier.?1.*item|base drugs.*tier.?1|all other.*tier.?1|tier.?1 drugs.*retail|tier.?1 drugs.*mail", "generic_rx_tier1"),
    ("outpatient pharmacy.*tier.?2|pharmacy.*tier.?2.*item|tier.?2.*item|base drugs.*tier.?2|all other.*tier.?2|tier.?2 drugs.*retail|tier.?2 drugs.*mail", "preferred_brand_rx_tier2"),
    # ── Hospital ──────────────────────────────────────────────────────────────
    ("hospital.*inpatient stay|hospital services and stay|hospital inpatient stay|inpatient stays|hospital inpatient stays", "inpatient_facility"),
    ("facility fee.*hospital|hospital room|inpatient.*facility|inpatient hospital", "inpatient_facility"),
    ("inpatient.*physician|inpatient.*doctor|inpatient.*surgeon|hospital.*doctor.*fee|inpatient.*doctor.*surgeon", "inpatient_physician"),
    # Outpatient surgery facility: very specific first
    ("facility fee.*ambulatory|ambulatory surgery.*facility|ambulatory surgery center|outpatient surgery.*facility", "outpatient_surgery_facility"),
    ("hospital services.*ambulatory|hospital services.*ambulatory surgical|hospital services.*asa", "outpatient_surgery_facility"),
    ("outpatient department.*hospital.*surgery|hospital.*outpatient.*surgery", "outpatient_surgery_facility"),
    ("outpatient surgery and procedures|outpatient surgery.procedures|any other outpatient surgery|outpatient.*surgery(?!/procedures requiring)", "outpatient_surgery_facility"),
    ("outpatient department of a hospital.*treatment|outpatient department.*treatment|outpatient department.*radiation", "outpatient_surgery_facility"),
    # Outpatient surgery physician
    ("physician.surgeon fees.*hospital|physician.surgeon fees|physician/surgeon fees|surgeon.*fees", "outpatient_surgery_physician"),
    ("hospital services.*outpatient.*doctor|hospital services.*outpatient.*physician|outpatient.*doctor.*fee", "outpatient_surgery_physician"),
    # Hospital outpatient visit (not surgery)
    ("hospital services.*outpatient visit|outpatient visit.*hospital|hospital.*outpatient.*visit", "outpatient_surgery_facility"),
    ("hospital stay.*physician|hospital stay.*surgeon|physician.*surgeon.*fee.*hospital|physician.surgeon fee.*inpatient", "inpatient_physician"),
    ("bariatric|weight loss surgery|obesity surgery|gastric bypass", "bariatric_surgery"),
    ("cosmetic surgery|reconstructive surgery", "cosmetic_surgery"),
    # ── Imaging / Lab ─────────────────────────────────────────────────────────
    ("ct scan|pet scan|mri |mri$|advanced imaging|magnetic resonance|computed tomography|imaging \\(ct|nuclear medicine", "advanced_imaging"),
    ("diagnostic test.*x.ray|x.ray|basic imaging|plain film", "imaging_basic"),
    ("diagnostic test|blood work|blood test", "diagnostic_test"),
    ("laboratory and pathology|laboratory.*pathology|laboratory.*center|lab.*outpatient|outpatient lab|laboratory services", "lab_outpatient"),
    # ── Maternity ─────────────────────────────────────────────────────────────
    ("childbirth.*facility|delivery.*facility|maternity.*facility|labor.*delivery.*facility", "delivery_facility"),
    ("childbirth.*professional|delivery.*professional|maternity.*professional|obstetric", "delivery_professional"),
    ("prenatal|postnatal|antenatal|pregnancy.*office visit|office visits.*pregnancy|maternity.*office|pregnancy office", "prenatal_visit"),
    ("infertility|fertility treatment|ivf|in vitro", "infertility_treatment"),
    ("well.baby|newborn|well child|well-baby", "well_baby"),
    # ── Mental health — specific inpatient FIRST ───────────────────────────────
    ("partial hospitali|intensive psychiatric|residential care.*mental|residential.*mental|residential.*behavioral", "mental_health_inpatient"),
    ("mental health.*inpatient|behavioral health.*inpatient|inpatient.*mental|inpatient.*behavioral|psychiatric.*inpatient", "mental_health_inpatient"),
    ("mental.*behavioral.*inpatient|behavioral.*mental.*inpatient|inpatient services.*mental|inpatient services.*behavioral|inpatient services.*substance", "mental_health_inpatient"),
    # Mental health outpatient
    ("autism spectrum disorder services.*inpatient|autism.*inpatient", "mental_health_inpatient"),
    ("individual mental health|group mental health|behavioral health treatment for autism|autism spectrum disorder services.*outpatient|psychological testing|autism spectrum disorder services", "mental_health_outpatient"),
    ("mental health.*outpatient|behavioral health.*outpatient|outpatient.*mental|psychiatric.*outpatient", "mental_health_outpatient"),
    ("mental.*behavioral.*outpatient|behavioral.*mental.*outpatient|outpatient services.*mental|outpatient services.*behavioral", "mental_health_outpatient"),
    # Substance use disorder
    ("individual.*substance|group.*substance|substance use.*individual|substance use.*group|methadone|substance use disorder.*outpatient", "substance_abuse_outpatient"),
    ("substance.*outpatient|drug.*outpatient|alcohol.*outpatient|outpatient.*substance|outpatient.*sud", "substance_abuse_outpatient"),
    ("residential.*substance|substance.*inpatient|drug.*inpatient|inpatient.*detox|detoxification|substance use disorder.*residential", "substance_abuse_inpatient"),
    # Combined MH+SUD (tricky)
    ("mental.*substance.*outpatient|mental.*behavioral.*substance.*outpatient|mental health.substance use.*outpatient", "mental_health_outpatient"),
    ("mental.*substance.*inpatient|mental.*behavioral.*substance.*inpatient|mental health.substance use.*inpatient", "mental_health_inpatient"),
    # ── Therapy ───────────────────────────────────────────────────────────────
    ("physical therapy|rehabilitation.*physical|physio|pt visit|rehabilitative.*physical", "pt_rehab"),
    ("occupational therapy|ot visit|occupational rehab|rehabilitative.*occupational|rehabilit.*occupational", "ot_rehab"),
    ("speech therapy|speech.language|speech pathology|rehabilitative.*speech|rehabilit.*speech", "speech_therapy"),
    ("cardiac.*rehab|cardiac rehabilitation|cardiopulmonary rehab", "cardiac_rehab"),
    ("rehabilitative and habilitative|rehabilitation services|rehab services|outpatient rehab|outpatient rehabilitative", "pt_rehab"),
    ("habilitation|hab services|early intervention|habilitative services|outpatient habilitative", "habilitation"),
    ("chiropractic|chiro visit|spinal manipulation", "chiropractic"),
    ("acupuncture", "acupuncture"),
    ("nutritional counsel|dietitian|nutrition services|medical nutrition therapy|diabetes.*nutrition|nutrition therapy", "nutritional_counseling"),
    ("foot care|podiatry|podiatric|routine foot", "routine_foot_care"),
    # ── Long-term / home / hospice ────────────────────────────────────────────
    ("skilled nursing|snf|skilled nursing facility", "skilled_nursing"),
    ("home health care|home health|home infusion agency|home care", "home_health"),
    ("hospice.*inpatient|inpatient.*hospice", "hospice_inpatient"),
    ("hospice.*outpatient|outpatient.*hospice", "hospice_outpatient"),
    ("hospice", "hospice_outpatient"),
    ("long.term care|custodial care|nursing home", "long_term_care"),
    ("private.duty nursing|private duty nursing|private duty", "private_duty_nursing"),
    # ── DME ───────────────────────────────────────────────────────────────────
    ("durable medical equipment|dme|prosthetic|orthotic|wheelchair|walker|crutch|glucose meter|blood glucose|insulin pump|devices.*equipment.*supplies|equipment.*supplies.*diabetes|diabetes.*devices|diabetes care.*devices|ostomy|urological supplies", "durable_medical_equipment"),
    ("hearing aid", "hearing_aids"),
    # ── Vision / Dental — specific first ──────────────────────────────────────
    ("children.*eye exam|pediatric.*eye exam|child.*eye exam|child vision.*exam|pediatric vision.*exam", "childrens_eye_exam"),
    ("children.*glass|pediatric.*glass|child.*glass|child.*lens|child vision.*lens|child vision.*frame|frames.*formulary|pediatric vision.*frame|child vision.*frame|low vision.*child|child.*low vision|pediatric.*low vision|low vision.*pediatric|child vision.*low vision|pediatric vision.*low vision", "childrens_glasses"),
    ("children.*dental|pediatric.*dental|child.*dental|child dental", "childrens_dental_checkup"),
    ("adult dental|dental care.*adult", "adult_dental_care"),
    ("dental.*orthodontic|orthodontic|braces", "dental_orthodontic"),
    ("vision.*adult|routine.*eye care.*adult|adult.*eye exam|adult.*routine vision|adult vision.*low vision", "routine_eye_care_adult"),
    ("vision exam|eye exam|routine vision|routine eye", "vision_exam"),
    ("glasses|contact lens|vision hardware|eyewear", "vision_hardware"),
    # ── Preventive catch-all ─────────────────────────────────────────────────
    ("weight loss program|obesity program|anti-obesity", "weight_loss_programs"),
]


def propose_slug(service_name):
    """Returns (slug_or_none, is_tricky, tricky_reason)."""
    name_lower = service_name.lower()

    matched_slug = None
    for pattern, slug in SLUG_RULES:
        if re.search(pattern, name_lower):
            matched_slug = slug
            break

    if matched_slug is None:
        return None, True, "NO_CONCEPT: no matching catalog slug"

    assert matched_slug in VALID_SLUGS, f"INVALID SLUG in rules: {matched_slug}"

    # Tricky detection: how many distinct slugs match?
    all_matched_slugs = []
    for pattern, slug in SLUG_RULES:
        if re.search(pattern, name_lower):
            all_matched_slugs.append(slug)

    distinct = list(dict.fromkeys(all_matched_slugs))
    tricky = False
    tricky_reason = ""

    if len(distinct) >= 2:
        tricky = True
        tricky_reason = f">=2 plausible slugs: {', '.join(distinct[:3])}"
    elif matched_slug in ("hospice_outpatient", "hospice_inpatient") and "hospice" in name_lower and not re.search(r"inpatient|outpatient", name_lower):
        tricky = True
        tricky_reason = "hospice without in/out qualifier"
    elif matched_slug == "telehealth_pcp" and "telehealth" in name_lower and not re.search(r"primary|pcp|specialist|general|mental", name_lower):
        tricky = True
        tricky_reason = "generic telehealth - pcp vs specialist unclear"
    elif matched_slug == "pt_rehab" and "rehabilitation" in name_lower and not re.search(r"physical|occupational|speech|cardiac|cardiac", name_lower):
        tricky = True
        tricky_reason = "generic rehabilitation - pt vs ot vs speech unclear"
    elif matched_slug in ("outpatient_surgery_facility", "outpatient_surgery_physician") and re.search(r"hospital.*outpatient|outpatient.*hospital|outpatient department", name_lower):
        tricky = True
        tricky_reason = "hospital outpatient visit vs outpatient surgery facility ambiguity"
    elif matched_slug in ("pcp_visit",) and re.search(r"other practitioner|nurse practitioner|physician assistant", name_lower):
        tricky = True
        tricky_reason = "other practitioner - could be pcp_visit or specialist_visit"

    return matched_slug, tricky, tricky_reason


# ─────────────────────────────────────────────────────────────────────────────
# Step 2: Normalize 6 ecm docs → GtService records
# ─────────────────────────────────────────────────────────────────────────────
gt_services = []

ecm_files = [
    ("ecm", "ecm.gt-candidate.json"),
    ("ecm-2", "ecm-2.gt-candidate.json"),
    ("ecm-6", "ecm-6.gt-candidate.json"),
    ("ecm-8", "ecm-8.gt-candidate.json"),
    ("ecm-9", "ecm-9.gt-candidate.json"),
    ("ecm-10", "ecm-10.gt-candidate.json"),
]

ecm_counts = {}
for doc_id, filename in ecm_files:
    with open(ECM_DIR / filename) as f:
        raw = json.load(f)

    meta = ECM_CANONICAL[doc_id]
    plan_year_raw = raw["doc_identity"].get("plan_year")
    plan_year = int(plan_year_raw) if plan_year_raw and str(plan_year_raw).isdigit() else None

    doc_services = []
    for idx, svc in enumerate(raw["services"]):
        svc_name = svc.get("service_name", "")
        binding_excerpt = svc.get("binding_excerpt") or svc.get("binding_text") or ""
        not_found = bool(svc.get("not_found"))

        svc_id = f"{doc_id}#{idx}"
        proposed_slug, tricky, tricky_reason = propose_slug(svc_name)

        entry = {
            "id": svc_id,
            "docId": doc_id,
            "insurer": meta["insurer"],
            "docType": "eoc",
            "planYear": plan_year,
            "canonicalPlanId": meta["canonicalPlanId"],
            "serviceName": svc_name,
            "bindingExcerpt": binding_excerpt if binding_excerpt else None,
            "correctSlug": proposed_slug,
            "adjudicationStatus": "auto",
            "tricky": tricky,
            "trickyReason": tricky_reason if tricky else None,
        }
        if not_found:
            entry["notFound"] = True

        doc_services.append(entry)

    ecm_counts[doc_id] = len(doc_services)
    gt_services.extend(doc_services)

print(f"Step 2 ecm: {sum(ecm_counts.values())} services across {len(ecm_files)} docs")
for k, v in ecm_counts.items():
    print(f"  {k}: {v}")

# ─────────────────────────────────────────────────────────────────────────────
# Step 3: Independently extracted services from 2 Clarity SBCs (from OCR)
# ─────────────────────────────────────────────────────────────────────────────

CLARITY_GOLD_SERVICES = [
    # Common Medical Event table (pages 2-5)
    {"name": "Primary care visit to treat an injury or illness", "excerpt": "Primary care visit to treat an injury or illness $30 Deductible does not apply Not covered"},
    {"name": "Specialist visit", "excerpt": "Specialist visit $60 Deductible does not apply Not covered"},
    {"name": "Preventive care / screening / Immunization", "excerpt": "Preventive care / screening / Immunization No charge Deductible does not apply Not covered"},
    {"name": "Diagnostic test (x-ray, blood work, ultrasound)", "excerpt": "Diagnostic test (x-ray, blood work, ultrasound) 25% coinsurance Not covered"},
    {"name": "Imaging (CT/PET scans, MRIs)", "excerpt": "Imaging (CT/PET scans, MRIs) 25% coinsurance Not covered"},
    {"name": "Generic drugs", "excerpt": "Generic drugs $15 retail and $37.50 mail order/prescription Deductible does not apply Not covered"},
    {"name": "Preferred brand drugs", "excerpt": "Preferred brand drugs $30 retail and $75 mail order/prescription Deductible does not apply Not covered"},
    {"name": "Non-preferred brand drugs", "excerpt": "Non-preferred brand drugs $60 retail and $150 mail order/prescription Deductible does not"},
    {"name": "Specialty drugs", "excerpt": "Specialty drugs $250 retail/prescription mail order prescription not covered Deductible does not apply Not covered"},
    {"name": "Facility fee (ambulatory surgery center) — outpatient surgery", "excerpt": "Facility fee (e.g., ambulatory surgery center) 25% coinsurance Not covered Includes diagnostic colonoscopies"},
    {"name": "Physician/surgeon fees — outpatient surgery", "excerpt": "Physician/surgeon fees 25% coinsurance Not covered"},
    {"name": "Emergency room care", "excerpt": "Emergency room care 25% coinsurance 25% coinsurance"},
    {"name": "Emergency medical transportation", "excerpt": "Emergency medical transportation 25% coinsurance 25% coinsurance None"},
    {"name": "Urgent care", "excerpt": "Urgent care $45 Deductible does not apply $45 Deductible does not apply"},
    {"name": "Facility fee (hospital room) — inpatient hospital stay", "excerpt": "Facility fee (e.g., hospital room) 25% coinsurance Not covered Pre-authorization is required"},
    {"name": "Physician/surgeon fees — inpatient hospital stay", "excerpt": "Physician/surgeon fees 25% coinsurance Not covered"},
    {"name": "Mental health / behavioral health outpatient services", "excerpt": "Outpatient services $30 Deductible does not apply Not covered Pre-authorization may be required"},
    {"name": "Mental health / behavioral health inpatient services", "excerpt": "Inpatient services 25% coinsurance Not covered"},
    {"name": "Prenatal and postnatal office visits", "excerpt": "Office visits 25% coinsurance Not covered Cost-sharing does not apply to routine prenatal and postpartum services"},
    {"name": "Childbirth/delivery professional services", "excerpt": "Childbirth/delivery professional services 25% coinsurance Not covered"},
    {"name": "Childbirth/delivery facility services", "excerpt": "Childbirth/delivery facility services 25% coinsurance Not covered"},
    {"name": "Home health care", "excerpt": "Home health care 25% coinsurance Not covered Pre-authorization is required"},
    {"name": "Rehabilitation services", "excerpt": "Rehabilitation services $30 for outpatient services Deductible does not apply 25% coinsurance for inpatient services Not covered"},
    {"name": "Habilitation services", "excerpt": "Habilitation services $30 Deductible does not apply Not covered"},
    {"name": "Skilled nursing care", "excerpt": "Skilled nursing care 25% coinsurance Not covered Limited to 100 calendar days per calendar year"},
    {"name": "Durable medical equipment", "excerpt": "Durable medical equipment 25% coinsurance Not covered"},
    {"name": "Hospice services", "excerpt": "Hospice services 25% coinsurance Not covered Pre-authorization is required"},
    {"name": "Children's eye exam", "excerpt": "Children's eye exam No charge for preventive exams; $60 for non-routine and routine exams. Not covered"},
    {"name": "Children's glasses", "excerpt": "Children's glasses 25% coinsurance Not covered"},
    {"name": "Children's dental check-up", "excerpt": "Children's dental check-up Not covered Not covered"},
    # Other Covered Services section
    {"name": "Bariatric surgery", "excerpt": "Bariatric surgery"},
    {"name": "Chiropractic care", "excerpt": "Chiropractic care (up to 12 visits per calendar year)"},
    {"name": "Hearing aids", "excerpt": "Hearing aids (1 hearing aid per ear each time a hearing aid prescription changes)"},
    {"name": "Infertility treatment (diagnostic tests only)", "excerpt": "Infertility treatment (limited to diagnostic tests to find the cause of infertility"},
    {"name": "Routine foot care", "excerpt": "Routine foot care (only for members with diabetes or systemic circulatory disease"},
]

CLARITY_BRONZE_SERVICES = [
    # Common Medical Event table (pages 2-5)
    {"name": "Primary care visit to treat an injury or illness", "excerpt": "Primary care visit to treat an injury or illness $50 Deductible does not apply Not covered"},
    {"name": "Specialist visit", "excerpt": "Specialist visit $100 Deductible does not apply Not covered"},
    {"name": "Preventive care / screening / Immunization", "excerpt": "Preventive care / screening / Immunization No charge Not covered"},
    {"name": "Diagnostic test (x-ray, blood work, ultrasounds)", "excerpt": "Diagnostic test (x-ray, blood work, ultrasounds) 50% coinsurance Not covered"},
    {"name": "Imaging (CT/PET scans, MRIs)", "excerpt": "Imaging (CT/PET scans, MRIs) 50% coinsurance Not covered"},
    {"name": "Generic drugs", "excerpt": "Generic drugs $25 retail and $62.50 mail order/prescription Deductible does not apply Not covered"},
    {"name": "Preferred brand drugs", "excerpt": "Preferred brand drugs $50 retail and $125 mail order/prescription Not covered"},
    {"name": "Non-preferred brand drugs", "excerpt": "Non-preferred brand drugs $100 retail and $250 mail order/prescription Not covered"},
    {"name": "Specialty drugs", "excerpt": "Specialty drugs $500 retail/prescription mail order prescription not covered Not covered"},
    {"name": "Facility fee (ambulatory surgery center) — outpatient surgery", "excerpt": "Facility fee (e.g., ambulatory surgery center) 50% coinsurance Not covered Includes diagnostic colonoscopies"},
    {"name": "Physician/surgeon fees — outpatient surgery", "excerpt": "Physician/surgeon fees 50% coinsurance Not covered"},
    {"name": "Emergency room care", "excerpt": "Emergency room care 50% coinsurance 50% coinsurance"},
    {"name": "Emergency medical transportation", "excerpt": "Emergency medical transportation 50% coinsurance 50% coinsurance None"},
    {"name": "Urgent care", "excerpt": "Urgent care $75 Deductible does not apply $75 Deductible does not apply"},
    {"name": "Facility fee (hospital room) — inpatient hospital stay", "excerpt": "Facility fee (e.g., hospital room) 50% coinsurance Not covered Pre-authorization is required"},
    {"name": "Physician/surgeon fees — inpatient hospital stay", "excerpt": "Physician/surgeon fees 50% coinsurance Not covered"},
    {"name": "Mental health / behavioral health / substance use disorder outpatient services", "excerpt": "Outpatient services $50 Deductible does not apply Not covered Pre-authorization may be required"},
    {"name": "Mental health / behavioral health / substance use disorder inpatient services", "excerpt": "Inpatient services 50% coinsurance Not covered"},
    {"name": "Prenatal and postnatal office visits", "excerpt": "Office visits 50% coinsurance Not covered Cost-sharing does not apply to routine prenatal and postpartum services"},
    {"name": "Childbirth/delivery professional services", "excerpt": "Childbirth/delivery professional services 50% coinsurance Not covered"},
    {"name": "Childbirth/delivery facility services", "excerpt": "Childbirth/delivery facility services 50% coinsurance Not covered"},
    {"name": "Home health care", "excerpt": "Home health care 50% coinsurance Not covered Pre-authorization is required"},
    {"name": "Rehabilitation services", "excerpt": "Rehabilitation services $50 Deductible does not apply 50% coinsurance for inpatient services Not covered"},
    {"name": "Habilitation services", "excerpt": "Habilitation services $50 Deductible does not apply Not covered"},
    {"name": "Skilled nursing care", "excerpt": "Skilled nursing care 50% coinsurance Not covered Limited to 100 calendar days per calendar year"},
    {"name": "Durable medical equipment", "excerpt": "Durable medical equipment 50% coinsurance Not covered"},
    {"name": "Hospice services", "excerpt": "Hospice services 50% coinsurance Not covered Pre-authorization is required"},
    {"name": "Children's eye exam", "excerpt": "Children's eye exam No charge for preventive exams; $100 for non-routine and routine exams. Deductible does not apply. Not covered"},
    {"name": "Children's glasses", "excerpt": "Children's glasses 50% coinsurance Not covered"},
    {"name": "Children's dental check-up", "excerpt": "Children's dental check-up Not covered Not covered"},
    # Other Covered Services section
    {"name": "Bariatric surgery", "excerpt": "Bariatric surgery"},
    {"name": "Chiropractic care", "excerpt": "Chiropractic care (up to 12 visits per calendar year)"},
    {"name": "Hearing aids", "excerpt": "Hearing aids (1 hearing aid per ear each time a hearing aid prescription changes)"},
    {"name": "Infertility treatment (diagnostic tests only)", "excerpt": "Infertility treatment (limited to diagnostic tests to find the cause of infertility"},
    {"name": "Routine foot care", "excerpt": "Routine foot care (only for members with diabetes or systemic circulatory disease"},
]


def normalize_text(t):
    return re.sub(r'\s+', ' ', t).lower().strip()


sbc_datasets = [
    ("clarity-gold-2000", CLARITY_GOLD_SERVICES, CLARITY_META["clarity-gold-2000"]),
    ("clarity-bronze-7500-hsa", CLARITY_BRONZE_SERVICES, CLARITY_META["clarity-bronze-7500-hsa"]),
]

sbc_counts = {}
for doc_id, services_raw, meta in sbc_datasets:
    ocr_text = Path(meta["ocrPath"]).read_text()
    ocr_norm = normalize_text(ocr_text)

    doc_services = []
    qa_failures = []
    for idx, svc in enumerate(services_raw):
        svc_id = f"{doc_id}#{idx}"
        name = svc["name"]
        excerpt = svc.get("excerpt", "")

        # QA: verify excerpt locatable in OCR
        not_found = False
        if excerpt and len(excerpt) > 10:
            key_words = [w for w in normalize_text(excerpt[:80]).split() if len(w) > 4][:5]
            found_count = sum(1 for w in key_words if w in ocr_norm)
            if key_words and found_count < len(key_words) // 2:
                not_found = True
                qa_failures.append(f"  QA FAIL [{svc_id}]: '{name}' excerpt not in OCR")

        proposed_slug, tricky, tricky_reason = propose_slug(name)

        entry = {
            "id": svc_id,
            "docId": doc_id,
            "insurer": meta["insurer"],
            "docType": "sbc",
            "planYear": 2026,
            "canonicalPlanId": meta["canonicalPlanId"],
            "serviceName": name,
            "bindingExcerpt": excerpt or None,
            "correctSlug": proposed_slug,
            "adjudicationStatus": "auto",
            "tricky": tricky,
            "trickyReason": tricky_reason if tricky else None,
        }
        if not_found:
            entry["notFound"] = True

        doc_services.append(entry)

    if qa_failures:
        print(f"[QA] {doc_id} — {len(qa_failures)} excerpt failures:")
        for f in qa_failures:
            print(f)
    else:
        print(f"[QA] {doc_id}: all {len(doc_services)} excerpts OK")

    count = len(doc_services)
    sbc_counts[doc_id] = count
    if count < 25 or count > 65:
        print(f"  WARNING: {doc_id} has {count} services — outside 25-65 band")
    else:
        print(f"  {doc_id}: {count} services (within 25-65 band OK)")

    gt_services.extend(doc_services)

print(f"\nStep 3 SBC: {sum(sbc_counts.values())} services")

# ─────────────────────────────────────────────────────────────────────────────
# Negative pair detection (same doc + same slug, distinct excerpts)
# ─────────────────────────────────────────────────────────────────────────────
slug_by_doc = defaultdict(lambda: defaultdict(list))
for svc in gt_services:
    slug = svc.get("correctSlug")
    if slug and not svc.get("notFound"):
        slug_by_doc[svc["docId"]][slug].append(svc["id"])

neg_pair_groups = 0
for doc_id, slug_map in slug_by_doc.items():
    for slug, ids in slug_map.items():
        if len(ids) >= 2:
            neg_pair_groups += 1
            for svc in gt_services:
                if svc["id"] in ids:
                    svc["isNegativePair"] = True
                    svc["negativePartnerIds"] = [i for i in ids if i != svc["id"]]
                    if not svc.get("tricky"):
                        svc["tricky"] = True
                        svc["trickyReason"] = f"negative pair: same slug '{slug}' within {doc_id}"

neg_pair_svcs = [s for s in gt_services if s.get("isNegativePair")]
print(f"\nNegative pair groups: {neg_pair_groups}, services flagged: {len(neg_pair_svcs)}")

# ─────────────────────────────────────────────────────────────────────────────
# Write gt.json
# ─────────────────────────────────────────────────────────────────────────────
gt_path = FREEZE_DIR / "gt.json"
gt_path.write_text(json.dumps(gt_services, indent=2))
print(f"\nWritten: {gt_path} ({len(gt_services)} entries)")

# ─────────────────────────────────────────────────────────────────────────────
# Write adjudication-worksheet.tsv
# ─────────────────────────────────────────────────────────────────────────────
tricky_svcs = [s for s in gt_services if s.get("tricky") and not s.get("notFound")]
non_tricky = [s for s in gt_services if not s.get("tricky") and not s.get("notFound")]

sample_size = max(0, 200 - len(tricky_svcs))
random.seed(42)
random_sample = random.sample(non_tricky, min(sample_size, len(non_tricky)))

worksheet_rows = list({s["id"]: s for s in (tricky_svcs + random_sample)}.values())

tsv_lines = ["id\tserviceName\tdocId\tinsurer\tproposed_slug\ttricky_reason\tRULING"]
for s in worksheet_rows:
    row = "\t".join([
        s["id"],
        s["serviceName"].replace("\t", " "),
        s["docId"],
        s["insurer"],
        s.get("correctSlug") or "NO_CONCEPT",
        (s.get("trickyReason") or "").replace("\t", " "),
        "",
    ])
    tsv_lines.append(row)

tsv_path = FREEZE_DIR / "adjudication-worksheet.tsv"
tsv_path.write_text("\n".join(tsv_lines))
print(f"Written: {tsv_path} ({len(worksheet_rows)} rows: {len(tricky_svcs)} tricky + {len(random_sample)} random)")

# ─────────────────────────────────────────────────────────────────────────────
# Write gt-sample-manifest.json
# ─────────────────────────────────────────────────────────────────────────────
manifest = {
    "frozenAt": "2026-06-03",
    "sbcDocs": [
        {
            "docId": "clarity-gold-2000",
            "pdfPath": CLARITY_META["clarity-gold-2000"]["pdfPath"],
            "canonicalPlanId": CLARITY_META["clarity-gold-2000"]["canonicalPlanId"],
            "planName": CLARITY_META["clarity-gold-2000"]["planName"],
            "insurer": CLARITY_META["clarity-gold-2000"]["insurer"],
            "planYear": 2026,
            "serviceCount": sbc_counts.get("clarity-gold-2000", 0),
        },
        {
            "docId": "clarity-bronze-7500-hsa",
            "pdfPath": CLARITY_META["clarity-bronze-7500-hsa"]["pdfPath"],
            "canonicalPlanId": CLARITY_META["clarity-bronze-7500-hsa"]["canonicalPlanId"],
            "planName": CLARITY_META["clarity-bronze-7500-hsa"]["planName"],
            "insurer": CLARITY_META["clarity-bronze-7500-hsa"]["insurer"],
            "planYear": 2026,
            "serviceCount": sbc_counts.get("clarity-bronze-7500-hsa", 0),
        },
    ],
    "ecmDocs": [
        {"docId": k, "canonicalPlanId": v["canonicalPlanId"], "insurer": v["insurer"], "serviceCount": ecm_counts.get(k, 0)}
        for k, v in ECM_CANONICAL.items()
    ],
}
manifest_path = FREEZE_DIR / "gt-sample-manifest.json"
manifest_path.write_text(json.dumps(manifest, indent=2))
print(f"Written: {manifest_path}")

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────
total = len(gt_services)
no_concept = sum(1 for s in gt_services if s.get("correctSlug") is None and not s.get("notFound"))
neg_pairs = sum(1 for s in gt_services if s.get("isNegativePair"))
not_found = sum(1 for s in gt_services if s.get("notFound"))
tricky_count = sum(1 for s in gt_services if s.get("tricky"))
slug_dist = defaultdict(int)
for s in gt_services:
    slug_dist[s.get("correctSlug") or "NO_CONCEPT"] += 1

print(f"""
=== GT SUMMARY ===
Total GtService records: {total}
  ecm docs (6):    {sum(ecm_counts.values())} services
  SBC docs (2):    {sum(sbc_counts.values())} services
  NO_CONCEPT:      {no_concept}
  notFound:        {not_found}
  isNegativePair:  {neg_pairs}
  tricky:          {tricky_count}

Top slug distribution:""")
for slug, cnt in sorted(slug_dist.items(), key=lambda x: -x[1])[:15]:
    print(f"  {slug}: {cnt}")
