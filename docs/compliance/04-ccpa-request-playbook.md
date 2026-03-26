# CCPA/CPRA & WA MHMDA Request Handling Playbook

Airgetlam Labs LLC / Candid
Version 1.0 — 2026-03-25

## 1. Request Types and Deadlines

| Request Type | Regulation | Deadline | How User Submits |
|---|---|---|---|
| Right to Know / Access | CCPA/CPRA | 45 days | Email or Settings page |
| Right to Delete | CCPA/CPRA, WA MHMDA | 30 days (MHMDA) / 45 days (CCPA) | Settings page or email |
| Right to Correct | CCPA/CPRA | 45 days | Email or profile edit |
| Right to Portability (export) | CCPA/CPRA | 45 days | Settings > Request Data Export |
| Right to Opt-Out of Sale | CCPA/CPRA | Immediate | GPC signal (auto) or email |
| Health Data Deletion | WA MHMDA | 30 days | Settings > Revoke Health Data Consent |
| Health Data Access | WA MHMDA | 30 days | Email |

**Important:** WA MHMDA has a 30-day deadline (stricter than CCPA's 45 days). Default to
30 days for all requests to stay safe.

## 2. Identity Verification

Before processing any request, verify the requester's identity:

1. **Authenticated user (via app):** Identity verified by Firebase Auth session. No additional verification needed for Settings page actions.
2. **Email request:** Verify the email matches an account in the `users` table. Reply asking the user to confirm from their registered email address if the request comes from a different address.
3. **If unable to verify:** Respond within 10 days requesting additional verification. The 45-day clock pauses until verification is complete (CCPA allows one 45-day extension with notice).

## 3. Handling Each Request Type

### 3.1 Data Export (Right to Know / Portability)

**Automated path:** User clicks "Request Data Export" in Settings. This creates a
`support_tickets` row with category `data_export_request`.

**Fulfillment SOP:**
1. Query all user data across tables:
   ```
   users, profiles, documents (metadata only), consent_events, support_tickets, stripe_customers
   ```
2. Export uploaded document files from Supabase Storage
3. Bundle as JSON + original files in a ZIP
4. Email the ZIP to the user's registered email (or provide a time-limited download link)
5. Update the support ticket to `resolved`
6. Must complete within 30 days

**Future automation:** Build `/api/account/export-generate` endpoint that auto-compiles
the export. For now, this is manual.

### 3.2 Account Deletion

**Self-service:** User deletes via Settings > Delete Account. Immediate cascade deletion.
**Email request:** Admin processes via admin panel within 7 business days.
**Confirm in writing:** Reply to the user confirming deletion is complete.

### 3.3 Data Correction

**Self-service:** User updates profile via Profile page.
**Email request:** Admin updates data via admin query endpoint. Log action in audit log.

### 3.4 Opt-Out of Sale/Sharing

**Current state:** Candid does not sell personal data. The marketplace feature (future)
requires separate consent (`marketplace_data_sharing`). Users opt out by revoking that consent.

**GPC signals:** Handled automatically by middleware. The `candid_gpc` cookie is set
when a browser sends `Sec-GPC: 1`. No marketplace data sharing occurs for users with
this cookie set.

## 4. Response Templates

### Acknowledgment (send within 10 days)
```
Subject: We received your data request

Dear [Name],

We received your [type of request] on [date]. We will fulfill your request
within 30 days. If we need additional time, we will notify you.

If you have questions, reply to this email.

Sincerely,
Candid Support
Airgetlam Labs LLC
```

### Completion
```
Subject: Your data request has been fulfilled

Dear [Name],

Your [type of request] submitted on [date] has been completed.

[For export: Your data export is attached / available for download at [link].]
[For deletion: All personal data associated with your account has been deleted.]
[For correction: The following data has been updated: [details].]

If you have questions, reply to this email.

Sincerely,
Candid Support
Airgetlam Labs LLC
```

## 5. Record Keeping

All requests must be tracked:
- `support_tickets` table (category: `data_export_request`, `deletion_request`, `correction_request`)
- Retain request records for 24 months per CCPA requirement
- Admin actions logged in `admin_audit_log`

## 6. Annual Review

Last review: 2026-03-25. Next review due: 2027-03-25.
