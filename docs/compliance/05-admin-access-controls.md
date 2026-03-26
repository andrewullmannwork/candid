# Admin Access Controls & Audit Policy

Airgetlam Labs LLC / Candid
Version 1.0 — 2026-03-25

## 1. Role-Based Access Control (RBAC)

### User Roles
| Role | Flag | Capabilities |
|---|---|---|
| User | `is_admin = false` | Full app access (upload, audit, disputes, profile, settings) |
| Admin | `is_admin = true` | All user capabilities + admin panel, user management, data queries |

### Admin Authentication Flow
1. Firebase Auth verifies identity (JWT token)
2. Token decoded server-side via Firebase Admin SDK
3. Supabase `users` table queried for `is_admin` flag
4. All admin API routes reject requests where `is_admin = false` with 403

### Row-Level Security (RLS)
All Supabase tables have RLS enabled. Users can only access their own rows.
Admin API routes use the Supabase service role client (bypasses RLS) for
cross-user queries. This is by design but means admin API routes are the
primary access control boundary.

## 2. Admin Audit Logging

### What Is Logged
Every admin action is recorded in the `admin_audit_log` table:

| Field | Type | Description |
|---|---|---|
| id | UUID | Auto-generated |
| admin_user_id | UUID | ID of the admin who performed the action |
| admin_email | TEXT | Email of the admin (for quick identification) |
| action | TEXT | Action type (see below) |
| target_user_id | UUID | User affected (if applicable) |
| target_table | TEXT | Table accessed (if applicable) |
| details | TEXT | Human-readable details |
| ip_address | TEXT | Admin's IP address |
| created_at | TIMESTAMPTZ | Timestamp |

### Action Types
| Action | Trigger | Details Logged |
|---|---|---|
| `user_delete` | Admin deletes a user | Target email, deletion cascade log |
| `query_table` | Admin queries a table | Table name |
| `update_record` | Admin updates a record | Table name, row ID |

### Setup
Run `POST /api/admin/setup-audit-log` once after deployment to create the table.
This endpoint is admin-only and idempotent (uses `CREATE TABLE IF NOT EXISTS`).

## 3. Access Review Schedule

**Quarterly (every 3 months):**
1. Review all users with `is_admin = true` in the `users` table
2. Verify each admin still needs access
3. Remove admin flag from anyone who no longer needs it
4. Review `admin_audit_log` for unusual patterns:
   - Bulk queries or deletions
   - Actions outside business hours
   - Queries against sensitive tables (consent_events, documents)

**Annual:**
1. Full access review as above
2. Rotate all service role keys (Supabase, Firebase, Stripe)
3. Review RLS policies in Supabase
4. Document findings in this file

## 4. Admin Onboarding/Offboarding

### Adding an Admin
1. Set `is_admin = true` in the `users` table for the target user
2. Log the change in `admin_audit_log` (action: `admin_grant`)
3. Notify the user of their new access level

### Removing an Admin
1. Set `is_admin = false` in the `users` table
2. Log the change in `admin_audit_log` (action: `admin_revoke`)
3. Verify no active admin sessions exist for the user

## 5. Current Admins

| Email | Role | Date Added | Last Access Review |
|---|---|---|---|
| andrew@airgetlamlabs.com | Founder / Admin | 2026-03-01 | 2026-03-25 |

## 6. Annual Review

Last review: 2026-03-25. Next review due: 2027-03-25.
