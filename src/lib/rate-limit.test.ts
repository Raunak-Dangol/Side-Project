import { describe, it, expect } from "vitest";
import { rateLimit, getClientId } from "./rate-limit";

// No UPSTASH_REDIS_* env is set in the test config, so this exercises the
// in-memory fallback path deterministically.
describe("rate limiter (in-memory fallback)", () => {
  it("allows up to `limit` requests then blocks", async () => {
    const key = `test:${Math.random().toString(36).slice(2)}`;
    const ok1 = await rateLimit({ key, limit: 2 });
    const ok2 = await rateLimit({ key, limit: 2 });
    const blocked = await rateLimit({ key, limit: 2 });

    expect(ok1.ok).toBe(true);
    expect(ok2.ok).toBe(true);
    expect(blocked.ok).toBe(false);
    expect(blocked.resetInMs).toBeGreaterThan(0);
  });

  it("tracks keys independently", async () => {
    const a = `a:${Math.random().toString(36).slice(2)}`;
    const b = `b:${Math.random().toString(36).slice(2)}`;
    await rateLimit({ key: a, limit: 1 });
    const aBlocked = await rateLimit({ key: a, limit: 1 });
    const bOk = await rateLimit({ key: b, limit: 1 });
    expect(aBlocked.ok).toBe(false);
    expect(bOk.ok).toBe(true);
  });
});

describe("getClientId", () => {
  it("prefers x-forwarded-for (first hop) and falls back to x-real-ip", () => {
    const reqFwd = new Request("https://x.test", {
      headers: { "x-forwarded-for": "203.0.113.5, 70.41.3.18" },
    });
    expect(getClientId(reqFwd)).toBe("203.0.113.5");

    const reqReal = new Request("https://x.test", {
      headers: { "x-real-ip": "198.51.100.7" },
    });
    expect(getClientId(reqReal)).toBe("198.51.100.7");
  });
});
