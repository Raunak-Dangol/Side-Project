import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { publicEnv } from "@/lib/env";

/**
 * Guards protected routes. Only runs on `/seller/*` so public pages (`/`,
 * `/browse`, `/stream/[id]`, ...) skip the `getUser()` network round-trip
 * entirely — this is the single biggest win for navigation speed. Pages that
 * need auth (`/orders`, `/checkout/return`) enforce it themselves via RLS or an
 * in-page `getUser()` check, not via this redirect.
 *
 * Token refresh: because middleware no longer runs on every request, a logged-in
 * user's session is refreshed lazily — when they next hit `/seller/*` or any
 * page that calls `getUser()`. Acceptable for a prototype whose browsing is
 * mostly anonymous.
 */
export async function middleware(request: NextRequest) {
  const response = NextResponse.next({ request });

  const supabase = createServerClient(
    publicEnv.supabaseUrl,
    publicEnv.supabaseAnonKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: Record<string, unknown> }[]) {
          // Set on the incoming request (so downstream handlers see them)...
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          // ...and mirror onto the outgoing response so they persist.
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // IMPORTANT: getUser() refreshes the session and writes updated cookies.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isProtected = path.startsWith("/seller");

  if (!user && isProtected) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirect", path);
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  // ONLY match /seller/* — public pages no longer pay the getUser() round-trip.
  matcher: ["/seller/:path*"],
};
