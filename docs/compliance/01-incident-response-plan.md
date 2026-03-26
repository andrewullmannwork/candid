# Incident Response Plan

Airgetlam Labs LLC / Candid
Version 1.0 — 2026-03-25

## 1. Purpose

This plan fulfills the promise in our Privacy Policy (Section 14): "We will notify affected
users promptly in the event of a data breach, consistent with applicable state breach
notification laws."

## 2. Incident Classification

| Severity | Definition | Example | Response Time |
|---|---|---|---|
| P0 — Critical | Confirmed unauthorized access to user health data or PII | Database exfiltration, admin credential compromise | Immediate (within 1 hour) |
| P1 — High | Suspected unauthorized access, or system compromise with potential data exposure | Suspicious admin login, unpatched vulnerability actively exploited | Within 4 hours |
| P2 — Medium | Security event with no confirmed data exposure | Failed brute-force, dependency vulnerability disclosed | Within 24 hours |
| P3 — Low | Minor security hygiene issue | Expired API key, misconfigured CORS on non-sensitive endpoint | Within 1 week |

## 3. Incident Response Steps

### 3.1 Detection & Triage (0–1 hour)
1. Identify the scope: which systems, which data categories, which users
2. Check admin audit log (`admin_audit_log` table) for unauthorized admin actions
3. Check Supabase auth logs for unauthorized access patterns
4. Check Vercel function logs for anomalous API calls
5. Assign severity level (P0–P3)

### 3.2 Containment (1–4 hours for P0/P1)
1. Rotate all compromised credentials immediately:
   - Supabase service role key (Supabase Dashboard > Settings > API)
   - Firebase service account key (GCP Console > IAM > Service Accounts)
   - Stripe secret key (Stripe Dashboard > Developers > API Keys)
   - Resend API key (Resend Dashboard > API Keys)
2. If admin account compromised: set `is_admin = false` in Supabase `users` table
3. If database compromised: enable Supabase "pause project" if needed
4. Document all containment actions with timestamps

### 3.3 Investigation (4–48 hours)
1. Query `admin_audit_log` for all actions by compromised account
2. Query `consent_events` for any unauthorized consent changes
3. Check Supabase storage access logs for document downloads
4. Determine exactly which users and data categories were affected
5. Preserve all evidence (export logs before rotation)

### 3.4 Notification (within statutory deadlines)

**State notification deadlines:**
| State | Deadline | Statute |
|---|---|---|
| California | 72 hours (to AG if 500+ residents) | Cal. Civ. Code 1798.82 |
| Washington | 30 days (45 for health data under MHMDA) | RCW 19.255.010 |
| Most other states | 30–60 days | Varies by state |

**Notification must include:**
- Description of the incident
- Categories of data involved
- Date or estimated date of the breach
- Steps we are taking
- Steps the user can take to protect themselves
- Contact information for questions

**Notification channels:**
1. Email to all affected users (via Resend)
2. If 500+ California residents: notify California Attorney General
3. If health data involved: notify per WA MHMDA requirements

### 3.5 Remediation
1. Patch the vulnerability or close the attack vector
2. Conduct post-mortem and document findings
3. Update security controls to prevent recurrence
4. Review and update this incident response plan

## 4. Notification Email Template

Subject: Important Security Notice from Candid

```
Dear [User Name],

We are writing to inform you of a security incident that may have affected your
personal information on Candid.

What happened: [Brief description]

What information was involved: [Specific data categories]

When it happened: [Date or date range]

What we are doing: [Containment and remediation steps taken]

What you can do: [Recommended user actions — change passwords, monitor accounts, etc.]

For questions, contact us at: support@candid.com

Sincerely,
Airgetlam Labs LLC
```

## 5. Annual Review

This plan must be reviewed and updated at least annually. The last review was conducted
on 2026-03-25. Next review due: 2027-03-25.
