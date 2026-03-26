# Vendor Data Processing Agreement (DPA) Tracker

Airgetlam Labs LLC / Candid
Version 1.0 — 2026-03-25

## 1. Purpose

Our Privacy Policy (Section 5) states all third-party providers operate "under data
processing agreements." This document tracks the DPA/BAA status for each vendor.

## 2. Vendor Registry

| Vendor | Data Shared | DPA Required | DPA Status | BAA Required | BAA Status | Renewal Date |
|---|---|---|---|---|---|---|
| **Supabase Inc.** | Account info, profile, health data, billing data | Yes | Covered by Supabase ToS (DPA included) | Yes | **PENDING — sign after Pro upgrade** | Annual |
| **Google Cloud Platform** | Auth tokens, uploaded files, Document AI processing | Yes | Covered by GCP Data Processing Terms (auto-accepted) | Yes | **PENDING — sign in Org project settings** | Annual |
| **Firebase (Google)** | Email, auth tokens, uploaded document files | Yes | Covered by Firebase/GCP terms | Yes | Covered by GCP BAA | Annual |
| **Stripe Inc.** | Email, subscription events | Yes | Covered by Stripe DPA (auto-accepted at signup) | No | N/A (no health data) | Annual |
| **Resend Inc.** | Email address, user name | Yes | Covered by Resend ToS (DPA included) | No | N/A (no health data) | Annual |
| **Vercel Inc.** | IP address (server logs only) | Yes | Covered by Vercel DPA (included in ToS) | No | N/A (no health data at rest) | Annual |

## 3. DPA Verification Checklist

For each vendor, verify:
- [ ] DPA covers the specific data categories we share (as listed in Privacy Policy Section 5)
- [ ] DPA includes data breach notification obligations
- [ ] DPA includes data deletion obligations upon contract termination
- [ ] DPA restricts sub-processor use or requires notification
- [ ] BAA covers HIPAA-eligible services (for Supabase and GCP only)

## 4. Pre-Launch Action Items

| # | Action | Owner | Status |
|---|---|---|---|
| 1 | Upgrade Supabase to Pro plan | Andrew | Pending |
| 2 | Sign Supabase BAA (Settings > Legal) | Andrew | Pending (requires Pro) |
| 3 | Sign GCP BAA (IAM > Settings) | Andrew | Pending |
| 4 | Verify GCP project is under Organization (not personal Gmail) | Andrew | Pending |
| 5 | Download and archive copies of all DPAs | Andrew | Pending |

## 5. Annual Review

Review all vendor DPAs and BAAs annually. Verify no vendors have changed their
data processing terms in ways that affect our compliance posture.

Last review: 2026-03-25. Next review due: 2027-03-25.
