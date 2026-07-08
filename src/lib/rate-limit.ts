/**
 * Tiny in-memory sliding-window rate limiter, keyed by an arbitrary string
 * (user id or IP). Fine for a single-instance prototype.
 *
 * TODO (post-prototype): move to Upstash Redis (@upstash/ratelimit) so the
 * limit is shared across all serverless instances and survives cold starts.
 */

interface Bucket {
  timestamps: number[];
}

const buckets = new Map<string, Bucket>();
const WINDOW_MS = 60_000; // 1 minute

export function rateLimit(args: {
  key: string;
  /** max requests per window */
  limit: number;
}): { ok: boolean; remaining: number; resetInMs: number } {
  const now = Date.now();
  const bucket = buckets.get(args.key) ?? { timestamps: [] };

  // Drop entries outside the window.
  bucket.timestamps = bucket.timestamps.filter(
    (t) => now - t < WINDOW_MS,
  );

  if (bucket.timestamps.length >= args.limit) {
    const oldest = bucket.timestamps[0];
    return {
      ok: false,
      remaining: 0,
      resetInMs: WINDOW_MS - (now - oldest),
    };
  }

  bucket.timestamps.push(now);
  buckets.set(args.key, bucket);
  return {
    ok: true,
    remaining: args.limit - bucket.timestamps.length,
    resetInMs: WINDOW_MS,
  };
}

/** Convenience: derive a best-effort client identifier from a Request. */
export function getClientId(req: Request): string {
  const xfwd = req.headers.get("x-forwarded-for");
  if (xfwd) return xfwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
