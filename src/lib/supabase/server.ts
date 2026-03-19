import { createClient } from "@supabase/supabase-js";

/**
 * Server-side Supabase client with service role (bypasses RLS).
 * Use only in API routes and server components.
 * TODO: Add typed generic after running `supabase gen types typescript`.
 */
export function createServerClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}
