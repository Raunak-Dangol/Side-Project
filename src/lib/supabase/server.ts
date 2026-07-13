import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { Database } from "@/lib/db-types";
import { serverEnv } from "@/lib/env/server";

/**
 * Server-side Supabase client that uses the ANON key and the user's session
 * cookies. RLS policies apply. Use this in Server Components, Route Handlers,
 * and Server Actions for user-scoped queries.
 *
 * In Next 15 `cookies()` is async, so we await it.
 *
 * NOTE: The return is cast to `SupabaseClient<Database>` because
 * `@supabase/ssr@0.5.x` passes its generic parameters to `SupabaseClient` in
 * an order that is incompatible with `@supabase/supabase-js@2.110+`, causing
 * the Schema type to resolve to `never`. The cast aligns the generic
 * resolution with how `createClient<Database>()` resolves it.
 */
export async function createSupabaseServerClient(): Promise<SupabaseClient<Database>> {
  const cookieStore = await cookies();
  return createServerClient<Database>(
    serverEnv.supabaseUrl,
    serverEnv.supabaseAnonKey,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: Record<string, unknown> }[]) {
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
  ) as unknown as SupabaseClient<Database>;
}

/**
 * Service-role client that BYPASSES RLS. Use ONLY in trusted server-side code
 * (e.g. inserting orders, verifying payments). NEVER import into a Client
 * Component or expose the key to the browser.
 */
export function createSupabaseServiceClient() {
  return createClient<Database>(
    serverEnv.supabaseUrl,
    serverEnv.supabaseServiceRoleKey,
    { auth: { persistSession: false } },
  );
}
