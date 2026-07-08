import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { Database } from "@/lib/db-types";

/**
 * Server-side Supabase client that uses the ANON key and the user's session
 * cookies. RLS policies apply. Use this in Server Components, Route Handlers,
 * and Server Actions for user-scoped queries.
 *
 * In Next 15 `cookies()` is async, so we await it.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component where cookies can't be mutated —
            // safe to ignore; middleware refreshes the session.
          }
        },
      },
    },
  );
}

/**
 * Service-role client that BYPASSES RLS. Use ONLY in trusted server-side code
 * (e.g. inserting orders, verifying payments). NEVER import into a Client
 * Component or expose the key to the browser.
 */
export function createSupabaseServiceClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}
