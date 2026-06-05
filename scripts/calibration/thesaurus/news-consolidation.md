# News consolidation — 62 rows → minimal Pattern S structure (S167)

Reconciled against the **live 69-slug catalog**. Rule: default **synonym → modifier → `is_a` child → new peer slug**; only split when compare-relevant (Hard Rule #17). This consolidated set (not the raw rows) feeds mig 148.

**Headline corrections from the existing catalog:**
- `non_emergency_care_outside_us` **already exists** (emergency) → the 5 "Non-emergency care outside the U.S." rows map to it (synonyms). `foreign_travel_care` proposal **dropped**.
- Existing `hospital` category (inpatient_*, outpatient_surgery_*, bariatric, cosmetic) is retired by the §D transform into `surgery`/`hospitalization`.

---

## family_planning (NEW cat) — 17 rows → 4 peers + 2 is_a children
| final slug | status | ← rows | structure |
|---|---|---|---|
| `abortion` | NEW | 5 | variants=synonyms; surgical vs medication = `place_of_service` modifier (surgical→outpatient_facility, medication→rx) |
| `sterilization` | NEW (parent) | 4 | place_of_service (ASC→independent/outpatient_facility) + component |
| `tubal_ligation` | NEW (is_a sterilization) | 1 | — |
| `vasectomy` | NEW (is_a sterilization) | 2 | synonyms |
| `contraceptives` | NEW | 2 | synonyms; drug/device/procedure → Phase-2 is_a if compare-demand |
| `family_planning_counseling` | NEW | 2 | synonyms |

## rx (existing) — 8 rows → 1 new slug + role mappings + 1 indication
| `non_preferred_brand_rx` | planned (D1) | 5 | tier#=`plan_tier_label`; names=synonyms |
| `preferred_brand_rx` | planned (D1) | 1 | — |
| role slug per tier **+ `indication=sexual_dysfunction`** | existing+indication | 2 | NO new slug |
| `allergy_injection` | NEW (your rx edit) | 1 | — |

## office_visit (existing) — 5 rows → 0 new slugs
| `specialist_visit` | existing | 4 | synonyms |
| `pcp_visit` | existing | 1 | + `place_of_service=home` |

## therapy (existing) — 4 rows → 2–3 new slugs
| `medical_foods` | NEW | 2 | ⚠ category: therapy vs **dme** vs rx — it's a product, not a service |
| `diabetes_education` | NEW | 1 | DSME |
| `early_intervention` | NEW? | 1 | ⚠ existing `habilitation` may cover this |

## maternity (existing) — 1 row → 1 new slug
| `doula_services` | NEW (your maternity edit) | 1 | — |

## surgery (NEW cat) — 4 rows → 1 new slug + D3 catch-all
| `transplant` | NEW | 2 | + `component` (facility/professional) — the 2 rows = 2 components of one service |
| `surgery` | planned (D3/N4) | 2 | pos=outpatient_facility, component; vital-sign distinction = synonyms |

## hospitalization (NEW cat) — 4 rows → 1 new slug + D3 admission
| `hospital_admission` | planned (D3 = transformed inpatient_physician) | 1 | + component=professional |
| `hospital_outpatient` | NEW (N4 catch-all) | 3 | outpatient×2=synonyms; Facility fee→component=facility; pos=outpatient_facility |

## dialysis (NEW cat) — 1 row → 1 new slug
| `dialysis` | NEW | 1 | + place_of_service (home / independent_facility) |

## vision (NEW cat) — 8 rows → 1 new slug + map to existing
| `vision_hardware` | existing (recat→vision) | 6 | pediatric contact lenses = synonyms; non-elective→`indication=medically_necessary`; is_a `contact_lenses` only if compare-demand |
| `medical_eye_care` | NEW? | 2 | ⚠ overlaps `specialist_visit` (ophthalmology medical visit) |

## dental (NEW cat) — 2 rows → 0 new slugs
| `childrens_dental` | existing (recat→dental) | 1 | maxillofacial prosthetics |
| `dental_orthodontic` | existing (recat→dental) | 1 | + `indication=medically_necessary` |

## emergency (existing) — 5 rows → 0 new slugs  ← the correction
| `non_emergency_care_outside_us` | existing | 5 | synonyms |

## preventive (existing) — 1 row → 1 new slug
| `covid_services` | NEW | 1 | tests vs therapeutics → Phase-2 is_a if needed |

## DROP
- "Other Eligible Providers" (row 27) — too vague.

---

## Totals
**62 rows → ~15 new slugs + 2 is_a children**, the rest mapping to existing/planned slugs.
New: abortion, sterilization(+tubal_ligation,+vasectomy), contraceptives, family_planning_counseling, allergy_injection, medical_foods, diabetes_education, early_intervention(?), doula_services, transplant, dialysis, hospital_outpatient, medical_eye_care(?), covid_services.
New indications: `sexual_dysfunction`, `medically_necessary`. New categories: family_planning, surgery, hospitalization, dialysis, vision, dental.

## Open micro-decisions (your call)
1. **early_intervention** → map to existing `habilitation`, or keep distinct?
2. **medical_foods** category → therapy / **dme** / rx? (it's a food product)
3. **sterilization** → is_a tree (parent + tubal_ligation + vasectomy children), or flat (one slug + sex/setting modifiers)?
4. **medical_eye_care** → distinct slug, or `specialist_visit` + a modifier? (ophthalmology = a specialist visit)
