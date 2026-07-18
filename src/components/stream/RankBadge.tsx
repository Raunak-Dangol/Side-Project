"use client";

import { useEffect, useState } from "react";

interface RankBadgeProps {
  streamId: string;
  /** Live viewer count from StreamView's presence channel — POSTed as the stat. */
  viewerCount: number;
}

const POLL_MS = 20_000;

/**
 * "hourly rank #{n}" pill. Two jobs on a ~20s cadence:
 *   1. POST this stream's current presence-derived viewer count to
 *      /api/streams/[id]/stats (service-role upsert; clients can't write stats
 *      directly).
 *   2. GET /api/streams/live-ranks and find this stream's rank.
 *
 * Hidden entirely when the rank is null/unknown (only one stream live, or the
 * stats row hasn't been written yet) — per the spec, never show a broken state.
 *
 * NOTE: stats POST requires auth; anon viewers skip the POST but still GET the
 * rank, so the badge works for everyone while only authenticated viewers
 * contribute to the count.
 */
export default function RankBadge({ streamId, viewerCount }: RankBadgeProps) {
  const [rank, setRank] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      // Fire both calls; the POST is best-effort (anon viewers 401 → skip).
      const statsPromise = fetch(`/api/streams/${streamId}/stats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ viewerCount }),
      }).catch(() => {});

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
  }, [streamId, viewerCount]);

  if (rank == null) return null;

  return (
    <div className="pointer-events-none absolute left-[12px] top-[52px] z-hud">
      <span className="inline-flex items-center gap-1 rounded-full bg-black/45 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
        🔥 <span className="text-gold-light">hourly rank #{rank}</span>
      </span>
    </div>
  );
}
