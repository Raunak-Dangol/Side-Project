import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { publicEnv } from "@/lib/env";
import { safeRelativePath } from "@/lib/auth-redirect";

/**
 * OAuth / magic-link callback. Exchanges the `code` for a session and forwards
 * the session cookies to the redirect response. Then sends the user to `next`.
 *
 * `next` is run through `safeRelativePath` before use: it clamps the value to a
 * same-origin relative path on an internal-route allowlist, refusing absolute
 * URLs, protocol-relative URLs (`//evil.com`), and anything outside known app
 * routes. Without this the callback was an open redirect (Phase 2 security fix).
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safeRelativePath(searchParams.get("next"));
  const errorParam = searchParams.get("error");

  const response = NextResponse.redirect(`${origin}${next}`);

  if (errorParam) {
    return NextResponse.redirect(`${origin}/login?error=${errorParam}`);
  }

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=no_code`);
  }

  const supabase = createServerClient(
    publicEnv.supabaseUrl,
    publicEnv.supabaseAnonKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: Record<string, unknown> }[]) {
          // Mirror the cookies the server client wants to set onto the
          // outgoing redirect response so the session survives the redirect.
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    },
  );

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(`${origin}/login?error=exchange_failed`);
  }
  return response;
}
