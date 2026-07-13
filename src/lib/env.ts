/**
 * Centralized environment configuration (client-safe half).
 *
 * Why this exists:
 *  - Every secret used to be read with `process.env.X!`, which crashes with a
 *    cryptic error (or, worse, silently defaults to localhost) when a var is
 *    missing. `requireEnv()` fails fast with a clear message instead.
 *  - It keeps server-only secrets (service-role key, LiveKit secret, payment
 *    HMAC secrets) out of the client bundle. Those live in `@/lib/env/server`
 *    and must only be imported from server-side modules.
 *
 * NOTE: the server env (with secrets) is intentionally in a SEPARATE module,
 * `@/lib/env/server`. Importing `publicEnv` here will NEVER pull server
 * secrets into the browser bundle or evaluate them, so a Client Component can
 * safely import `publicEnv` without risking a crash over a missing server var.
 */

/**
 * Throw a clear error if a required env var is missing.
 *
 * IMPORTANT: this uses `process.env[name]` with a COMPUTED key, which the
 * bundler (Turbopack/webpack) CANNOT statically inline into the client
 * bundle. Next.js only replaces `NEXT_PUBLIC_*` vars when they are read via
 * STATIC member access (e.g. `process.env.NEXT_PUBLIC_FOO`). So `requireEnv`
 * must ONLY be called from server code — for client-safe vars, read them with
 * static access first (see `publicEnv` below) and pass the value here to
 * validate emptiness.
 */
export function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Client-safe configuration. Only `NEXT_PUBLIC_*` vars (safe to expose).
 *
 * Each var is read with STATIC member access (`process.env.NEXT_PUBLIC_X`) so
 * the bundler inlines its value into the client bundle at build time; the
 * result is then validated via `requireEnv` so a missing var still fails fast
 * with a clear message instead of silently becoming `undefined`.
 */
export const publicEnv = {
  supabaseUrl: requireEnv(
    "NEXT_PUBLIC_SUPABASE_URL",
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  ),
  supabaseAnonKey: requireEnv(
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  ),
  livekitUrl: process.env.NEXT_PUBLIC_LIVEKIT_URL ?? "",
  appUrl: resolveAppUrl(),
} as const;

/**
 * The app's public base URL — used for gateway return URLs. In production this
 * MUST be set (a localhost default would send real payments back to the wrong
 * place), so we fail fast if it's missing outside of development.
 */
export function resolveAppUrl(): string {
  const url = process.env.NEXT_PUBLIC_APP_URL;
  if (url) return url;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Missing required environment variable: NEXT_PUBLIC_APP_URL (required in production for payment redirects)",
    );
  }
  return "http://localhost:3000";
}
