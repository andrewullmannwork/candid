# Encryption Verification Record

Airgetlam Labs LLC / Candid
Version 1.0 — 2026-03-25

## 1. Purpose

Our Health Data Consent (Section 4) and Privacy Policy (Section 14) promise:
- "Health data is encrypted at rest (AES-256) and in transit (TLS 1.2+)"
- "Encryption in transit (TLS 1.2+)" and "Encryption at rest (AES-256 for stored data)"

This document verifies these claims against our infrastructure providers.

## 2. Encryption at Rest

### Supabase (Database — Postgres)
- **Provider:** Supabase Inc. (AWS us-east-1)
- **Encryption:** AES-256 via AWS EBS volume encryption (enabled by default on all Supabase projects)
- **Key management:** AWS KMS managed keys
- **Verification:** Supabase docs confirm all data is encrypted at rest: https://supabase.com/docs/guides/platform/going-into-prod#security
- **Tables containing health data:** `documents` (extracted billing data, audit results)
- **Status: COMPLIANT**

### Supabase Storage (Document files)
- **Encryption:** AES-256 via AWS S3 server-side encryption (SSE-S3), enabled by default
- **Bucket:** `documents` bucket stores uploaded medical bills, EOBs
- **Status: COMPLIANT**

### Firebase / Google Cloud Storage (File storage)
- **Provider:** Google Cloud Platform
- **Encryption:** AES-256 via Google-managed encryption keys (enabled by default on all GCS buckets)
- **Documentation:** https://cloud.google.com/storage/docs/encryption
- **Status: COMPLIANT**

### Firebase Authentication
- **Provider:** Google Cloud Platform
- **Encryption:** User credentials (password hashes) stored with scrypt hashing, encrypted at rest via Google infrastructure default AES-256
- **Status: COMPLIANT**

## 3. Encryption in Transit

### Application Layer
- **Vercel:** All traffic served over HTTPS (TLS 1.2+). HTTP requests are automatically redirected to HTTPS. Verified by `next.config.ts` security headers including `Strict-Transport-Security`.
- **Supabase API:** All connections use TLS 1.2+. Connection string uses `sslmode=require`.
- **Firebase SDK:** All API calls use HTTPS.
- **Stripe SDK:** All API calls use TLS 1.2+.
- **Resend API:** All API calls use HTTPS.
- **Document AI API:** All API calls use HTTPS via Google Cloud client library.
- **Status: COMPLIANT**

### Browser to Server
- **HSTS header:** Set in `next.config.ts` — `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- **Status: COMPLIANT**

## 4. What We Do NOT Implement (and why)

- **Application-level encryption (double encryption):** We rely on infrastructure-provider encryption at rest rather than encrypting data before storing it. This is industry standard for SaaS applications. Application-level encryption would prevent server-side queries and searches, making the audit/matching features impossible.
- **Client-side encryption:** Not implemented because server-side processing (Document AI OCR, audit analysis) requires access to plaintext document content.

## 5. BAA Status

| Provider | BAA Required | BAA Signed | Date |
|---|---|---|---|
| Supabase (Pro plan) | Yes | Pending | — |
| Google Cloud Platform | Yes | Pending | — |
| Stripe | No (no health data shared) | N/A | — |
| Resend | No (email address only) | N/A | — |
| Vercel | No (no health data at rest) | N/A | — |

**Action items:** Sign Supabase and GCP BAAs before go-live.

## 6. Annual Review

Verify encryption settings haven't changed on any provider. Re-check default encryption
documentation URLs. Review BAA status.
Last review: 2026-03-25. Next review due: 2027-03-25.
