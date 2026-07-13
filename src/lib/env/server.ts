/**
 * Server-only environment configuration. Includes secrets — do NOT import from
 * client code. Import this from `@/lib/env/server`, never from `@/lib/env`
 * (which is the client-safe module).
 *
 * This module is intentionally separate from the client-safe `env.ts` so that
 * importing `publicEnv` in a Client Component can never pull server secrets
 * into the browser bundle or force them to be evaluated on the client.
 */
import { requireEnv, resolveAppUrl } from "@/lib/env";

export const serverEnv = {
  supabaseUrl: requireEnv(
    "NEXT_PUBLIC_SUPABASE_URL",
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  ),
  supabaseAnonKey: requireEnv(
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  ),
  supabaseServiceRoleKey: requireEnv(
    "SUPABASE_SERVICE_ROLE_KEY",
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  ),

  livekitApiKey: requireEnv("LIVEKIT_API_KEY", process.env.LIVEKIT_API_KEY),
  livekitApiSecret: requireEnv(
    "LIVEKIT_API_SECRET",
    process.env.LIVEKIT_API_SECRET,
  ),

  khaltiSecretKey: requireEnv(
    "KHALTI_SECRET_KEY",
    process.env.KHALTI_SECRET_KEY,
  ),
  esewaSecretKey: requireEnv("ESEWA_SECRET_KEY", process.env.ESEWA_SECRET_KEY),

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
