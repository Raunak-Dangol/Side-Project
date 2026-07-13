"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db-types";
import { publicEnv } from "@/lib/env";

/**
 * Browser-side Supabase client bound to the user's session. RLS applies.
 * Uses only public env vars (never server secrets).
 *
 * Cast to `SupabaseClient<Database>` for the same SSR generic mismatch
 * reason documented in server.ts.
 */
export function createSupabaseBrowserClient(): SupabaseClient<Database> {
  return createBrowserClient<Database>(
    publicEnv.supabaseUrl,
    publicEnv.supabaseAnonKey,
  ) as unknown as SupabaseClient<Database>;
}
