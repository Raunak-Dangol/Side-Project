"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/db-types";

/**
 * Browser-side Supabase client bound to the user's session. RLS applies.
 */
export function createSupabaseBrowserClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
