# Data Retention & Purge Standard Operating Procedures

Airgetlam Labs LLC / Candid
Version 1.0 — 2026-03-25

## 1. Retention Schedule

These retention periods are legally binding — they are published in our Privacy Policy
(Section 6) and Health Data Consent (Section 4).

| Data Category | Retention Period | Purge Trigger | Enforcement |
|---|---|---|---|
| Account data (name, email, state) | Lifetime of account | Account deletion request | `/api/account/delete` or admin deletion |
| Personal data post-deletion | 30 days max | Account deletion | Immediate deletion via cascade |
| Health documents (uploaded files) | Until user deletes or account closes | Consent revocation or account deletion | `/api/consent/revoke` + `/api/account/delete` |
| Extracted billing data | Until user deletes or account closes | Consent revocation or account deletion | Same as above |
| Server access logs (IP addresses) | 90 days max | Time-based | Vercel log retention config (see Section 3) |
| Payment records | 7 years | IRS requirement | Manual review annually |
| Support communications | 2 years after resolution | Time-based | Scheduled purge (see Section 4) |
| Encrypted backups containing health data | 90 days after source deletion | Source data deleted | Infrastructure-level (see Section 5) |

## 2. Account Deletion Procedure

**User self-service:** Settings > Privacy & Data > Delete Account
- Endpoint: `POST /api/account/delete`
- Cascade: storage files > documents > support_tickets > consent_events > stripe_customers > profiles > users > Firebase Auth
- Timeline: immediate (exceeds 30-day promise)

**Admin-initiated:** Admin panel > Users > Delete
- Endpoint: `POST /api/admin/users/delete`
- Same cascade as above
- Action logged in `admin_audit_log`

**Support ticket:** User submits a support ticket at candidclaim.com
- SOP: Admin processes within 7 business days using admin deletion endpoint
- Confirm deletion to user in writing (via support ticket reply)

## 3. Server Log Retention (90-day promise)

**Vercel:** Vercel's log retention varies by plan:
- Hobby: 1 hour (automatically compliant)
- Pro: 3 days (automatically compliant)
- Enterprise: configurable

**Action required:** After deploying to Vercel, verify the plan's log retention period
in the Vercel dashboard (Settings > General > Logs). If on Enterprise plan, configure
retention to 90 days maximum.

**Supabase:** Supabase retains Postgres logs for 7 days by default on Pro plan.
This is automatically compliant.

## 4. Support Ticket Purge (2-year promise)

**Current state:** No automated purge. Must be implemented.

**Interim SOP (manual):** Run quarterly via admin query endpoint:
```sql
DELETE FROM support_tickets
WHERE status = 'resolved'
AND updated_at < NOW() - INTERVAL '2 years';
```

**Future automation:** Create a Supabase Edge Function or cron job that runs monthly:
1. Query `support_tickets` where `status = 'resolved'` and `updated_at < NOW() - INTERVAL '2 years'`
2. Delete matching rows
3. Log the count in `admin_audit_log`

**Responsibility:** Andrew (founder) runs this quarterly until automation is built.

## 5. Backup Purge (90-day promise for health data)

**Supabase Pro:** Daily backups retained for 7 days. Automatically compliant.
**Firebase/GCS:** Default backup retention is 7 days. Automatically compliant.

If backup retention settings change (e.g., upgrading to longer backup windows), verify
they do not exceed 90 days for buckets containing health data.

## 6. Audit Trail

All data deletion actions are logged:
- User self-deletion: recorded in application logs (Vercel function logs)
- Admin deletion: recorded in `admin_audit_log` table
- Consent revocation: recorded in `consent_events` table (granted=false event)

## 7. Annual Review

Review this document and verify all retention periods are being enforced.
Last review: 2026-03-25. Next review due: 2027-03-25.
