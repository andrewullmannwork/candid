# Candid Compliance Documentation Index

Operated by Airgetlam Labs LLC

Last updated: 2026-03-25

## Regulatory Framework

Candid operates at the intersection of healthcare data, consumer finance, and technology.
The following regulations apply:

| Regulation | Scope | Key Obligations |
|---|---|---|
| CCPA/CPRA (California) | All CA users' personal info | Right to know, delete, correct, port, opt-out; 45-day response; GPC signals |
| WA My Health My Data Act (RCW 19.373) | All WA users' health data | Separate consent, homepage link, 30-day deletion, no geofencing, private right of action |
| HIPAA | Not directly applicable (Candid is not a covered entity) | Voluntary adoption of Security Rule best practices; BAAs signed with processors |
| State breach notification laws | All users | Prompt notification per each state's timeline requirements |

## Document Registry

| # | Document | Location | Purpose |
|---|---|---|---|
| 1 | [Incident Response Plan](./01-incident-response-plan.md) | This directory | Breach detection, containment, notification procedures |
| 2 | [Data Retention & Purge SOPs](./02-data-retention-sops.md) | This directory | Scheduled purge procedures for logs, support tickets, backups |
| 3 | [Encryption Verification](./03-encryption-verification.md) | This directory | AES-256 at rest verification for Supabase, Firebase/GCS |
| 4 | [CCPA Request Playbook](./04-ccpa-request-playbook.md) | This directory | Handling data access, deletion, correction requests |
| 5 | [Admin Access Controls](./05-admin-access-controls.md) | This directory | RBAC policies, audit logging, access review schedule |
| 6 | [Vendor DPA Tracker](./06-vendor-dpa-tracker.md) | This directory | Data Processing Agreement status for each vendor |

## Consent Documents (in-code, git-auditable)

All consent documents are stored in `src/lib/consent/consent-documents.ts` and versioned
in git history. When text changes, versions are bumped and users must re-consent via
`ConsentGate` component before accessing gated features.

Current versions: v1.2 (all documents), effective 2026-03-25.
