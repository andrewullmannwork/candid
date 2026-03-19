import { createClient } from "@supabase/supabase-js";

/**
 * Browser-side Supabase client (anon key, subject to RLS).
 * TODO: Add typed generic after running `supabase gen types typescript`.
 */
export function createBrowserClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
