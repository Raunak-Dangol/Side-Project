import { serverEnv } from "@/lib/env";

/**
 * Sliding-window rate limiter.
 *
 * - When `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` are configured,
 *   uses a shared Upstash Redis limiter that is correct across serverless
 *   instances and survives cold starts.
 * - Otherwise falls back to an in-memory limiter, which is correct for a single
 *   instance / local dev.
 *
 * The public signature (`rateLimit({ key, limit })`) is the same regardless of
 * backend, so callers don't care which is active.
 */

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  resetInMs: number;
}

const WINDOW_MS = 60_000; // 1 minute

// ── In-memory fallback (single instance) ──────────────────────────────────────

interface Bucket {
  timestamps: number[];
}

const buckets = new Map<string, Bucket>();

function memoryRateLimit(key: string, limit: number): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { timestamps: [] };

  // Drop entries outside the window.
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < WINDOW_MS);

  if (bucket.timestamps.length >= limit) {
    const oldest = bucket.timestamps[0]!;
    return {
      ok: false,
      remaining: 0,
      resetInMs: WINDOW_MS - (now - oldest),
    };
  }

  bucket.timestamps.push(now);
  buckets.set(key, bucket);
  return {
    ok: true,
    remaining: limit - bucket.timestamps.length,
    resetInMs: WINDOW_MS,
  };
}

// ── Upstash Redis (multi-instance / serverless) ──────────────────────────────

/** Minimal structural type so we avoid `any` while staying backend-agnostic. */
interface UpstashLimiter {
  limit: (key: string) => Promise<{
    success: boolean;
    remaining: number;
    reset: number;
  }>;
}

let upstashAvailable: boolean | null = null;
let limitersByLimit: Map<number, UpstashLimiter> | null = null;

async function getUpstashLimiter(limit: number): Promise<UpstashLimiter | null> {
  const url = serverEnv.upstashRedisRestUrl;
  const token = serverEnv.upstashRedisRestToken;
  if (!url || !token) return null;

  if (upstashAvailable === null) upstashAvailable = true;
  try {
    if (!limitersByLimit) {
      const { Ratelimit } = await import("@upstash/ratelimit");
      const { Redis } = await import("@upstash/redis");
      const redis = new Redis({ url, token });
      limitersByLimit = new Map();
      limitersByLimit.set(
        limit,
        new Ratelimit({
          redis,
          limiter: Ratelimit.slidingWindow(limit, "1 m"),
          analytics: false,
        }) as unknown as UpstashLimiter,
      );
    }
    let rl = limitersByLimit.get(limit);
    if (!rl) {
      const { Ratelimit } = await import("@upstash/ratelimit");
      const { Redis } = await import("@upstash/redis");
      const redis = new Redis({ url, token });
      rl = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(limit, "1 m"),
        analytics: false,
      }) as unknown as UpstashLimiter;
      limitersByLimit.set(limit, rl);
    }
    return rl;
  } catch {
    // If Redis can't be reached at module init, degrade to in-memory.
    return null;
  }
}

/**
 * Returns whether `key` is within its limit for the current window.
 */
export async function rateLimit(args: {
  key: string;
  limit: number;
}): Promise<RateLimitResult> {
  const rl = await getUpstashLimiter(args.limit);
  if (rl) {
    const { success, remaining, reset } = await rl.limit(args.key);
    return {
      ok: success,
      remaining,
      resetInMs: Math.max(0, reset - Date.now()),
    };
  }
  return memoryRateLimit(args.key, args.limit);
}

/** Convenience: derive a best-effort client identifier from a Request. */
export function getClientId(req: Request): string {
  // NOTE: x-forwarded-for is client-supplied and can be spoofed. Acceptable for
  // a prototype rate limit; a more robust identifier would combine it with other
  // signals or use a signed token.
  const xfwd = req.headers.get("x-forwarded-for");
  if (xfwd) return xfwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
