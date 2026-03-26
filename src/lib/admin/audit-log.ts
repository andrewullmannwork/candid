import { createServerClient } from "@/lib/supabase/server";

export async function logAdminAction(params: {
  adminUserId: string;
  adminEmail: string;
  action: string; // e.g. "user_delete", "query_table", "view_tickets"
  targetUserId?: string;
  targetTable?: string;
  details?: string; // human-readable detail
  ipAddress?: string | null;
}) {
  const supabase = createServerClient();
  await supabase.from("admin_audit_log").insert({
    admin_user_id: params.adminUserId,
    admin_email: params.adminEmail,
    action: params.action,
    target_user_id: params.targetUserId || null,
    target_table: params.targetTable || null,
    details: params.details || null,
    ip_address: params.ipAddress || null,
  });
}
