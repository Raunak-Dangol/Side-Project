import type { SupabaseClient, User } from "@supabase/supabase-js";

/**
 * Returns the authenticated user, or `null` if there isn't one. Replaces the
 * repeated `const { data: { user } } = await supabase.auth.getUser()` +
 * null-check boilerplate used across API routes.
 *
 * Works with any Supabase client (anon/session or service role). The caller is
 * responsible for deciding what to do with a `null` result (401, redirect, etc).
 */
export async function getAuthenticatedUser(
  supabase: SupabaseClient,
): Promise<User | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user ?? null;
}
