"use client";

import { useEffect, useRef, useState } from "react";

interface RankBadgeProps {
  streamId: string;
  /** Live viewer count from StreamView's presence channel — POSTed as the stat. */
  viewerCount: number;
  /**
   * Only the stream owner may POST stats (API returns 403 otherwise). When
   * false/undefined we skip the POST entirely so viewers don't hammer a
   * non-retryable 4xx every 20s.
   */
  canReportStats?: boolean;
}

const POLL_MS = 20_000;

/**
 * "hourly rank #{n}" pill. Two jobs on a ~20s cadence:
 *   1. POST this stream's current presence-derived viewer count to
 *      /api/streams/[id]/stats — ONLY when `canReportStats` is true (seller).
 *   2. GET /api/streams/live-ranks and find this stream's rank.
 *
 * Hidden entirely when the rank is null/unknown (only one stream live, or the
 * stats row hasn't been written yet) — per the spec, never show a broken state.
 *
 * Non-retryable 4xx on the stats POST (401/403) permanently disables further
 * POSTs for this mount so we never loop 403s in production logs.
 */
export default function RankBadge({
  streamId,
  viewerCount,
  canReportStats = false,
}: RankBadgeProps) {
  const [rank, setRank] = useState<number | null>(null);
  // Once the server rejects the POST as non-retryable, stop trying.
  const statsBlockedRef = useRef(!canReportStats);

  useEffect(() => {
    // Re-evaluate if the seller flag flips mid-session (auth lands late).
    statsBlockedRef.current = !canReportStats;
  }, [canReportStats]);

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      // Stats POST: seller-only, and stop forever on non-retryable 4xx.
      let statsPromise: Promise<unknown> = Promise.resolve();
      if (!statsBlockedRef.current) {
        statsPromise = fetch(`/api/streams/${streamId}/stats`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ viewerCount }),
        })
          .then((res) => {
            // 401 Unauthorized / 403 Forbidden are permanent for this client —
            // never retry. 429 is transient; leave the flag alone so the next
            // tick can try again after the rate-limit window.
            if (res.status === 401 || res.status === 403) {
              statsBlockedRef.current = true;
            }
          })
          .catch(() => {
            // Network blip — leave the flag alone so the next tick retries.
          });
      }

      try {
        const [res] = await Promise.all([
          fetch(`/api/streams/live-ranks`, { cache: "no-store" }),
          statsPromise,
        ]);
        if (!res.ok) return;
        const data = (await res.json()) as {
          ranks: Array<{ id: string; rank: number }>;
        };
        if (cancelled) return;
        const mine = data.ranks.find((r) => r.id === streamId);
        setRank(mine?.rank ?? null);
      } catch {
        // Keep the last known rank; next tick retries.
      }
    }

    tick();
    const interval = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [streamId, viewerCount, canReportStats]);

  if (rank == null) return null;

  return (
    <div className="pointer-events-none absolute left-[12px] top-[52px] z-hud">
      <span className="inline-flex items-center gap-1 rounded-full bg-black/45 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
        🔥 <span className="text-gold-light">hourly rank #{rank}</span>
      </span>
    </div>
  );
}
