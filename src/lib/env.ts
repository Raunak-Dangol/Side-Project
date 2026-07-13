/**
 * Centralized environment configuration.
 *
 * Why this exists:
 *  - Every secret used to be read with `process.env.X!`, which crashes with a
 *    cryptic error (or, worse, silently defaults to localhost) when a var is
 *    missing. `requireEnv()` fails fast with a clear message instead.
 *  - It keeps server-only secrets (service-role key, LiveKit secret, payment
 *    HMAC secrets) out of the client bundle: client code must import
 *    `publicEnv`, never `serverEnv`.
 *
 * NOTE: `serverEnv` is imported only from server-side modules (route handlers,
 * server components, middleware, livekit, payments). Importing it into a Client
 * Component would leak secrets into the browser bundle.
 */

/** Throw a clear error if a required env var is missing. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Server-only configuration. Includes secrets — do NOT import from client code.
 */
export const serverEnv = {
  supabaseUrl: requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseAnonKey: requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  supabaseServiceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),

  livekitApiKey: requireEnv("LIVEKIT_API_KEY"),
  livekitApiSecret: requireEnv("LIVEKIT_API_SECRET"),

  khaltiSecretKey: requireEnv("KHALTI_SECRET_KEY"),
  esewaSecretKey: requireEnv("ESEWA_SECRET_KEY"),

  khaltiBaseUrl: process.env.KHALTI_BASE_URL ?? "https://dev.khalti.com",
  appUrl: resolveAppUrl(),
  esewaProductCode: process.env.ESEWA_PRODUCT_CODE ?? "EPAYTEST",
  esewaFormUrl:
    process.env.ESEWA_FORM_URL ??
    "https://rc-epay.esewa.com.np/api/epay/main/v2/form",
  esewaStatusUrl:
    process.env.ESEWA_STATUS_URL ??
    "https://rc-epay.esewa.com.np/api/epay/transaction/status/",

  /** Optional Upstash Redis — enables the shared rate limiter when set. */
  upstashRedisRestUrl: process.env.UPSTASH_REDIS_REST_URL ?? null,
  upstashRedisRestToken: process.env.UPSTASH_REDIS_REST_TOKEN ?? null,
} as const;

/**
 * Client-safe configuration. Only `NEXT_PUBLIC_*` vars (safe to expose).
 */
export const publicEnv = {
  supabaseUrl: requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseAnonKey: requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  livekitUrl: process.env.NEXT_PUBLIC_LIVEKIT_URL ?? "",
  appUrl: resolveAppUrl(),
} as const;

/**
 * The app's public base URL — used for gateway return URLs. In production this
 * MUST be set (a localhost default would send real payments back to the wrong
 * place), so we fail fast if it's missing outside of development.
 */
function resolveAppUrl(): string {
  const url = process.env.NEXT_PUBLIC_APP_URL;
  if (url) return url;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Missing required environment variable: NEXT_PUBLIC_APP_URL (required in production for payment redirects)",
    );
  }
  return "http://localhost:3000";
}
