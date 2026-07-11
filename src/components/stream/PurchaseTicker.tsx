"use client";

import { useEffect, useState } from "react";

interface PurchaseTickerProps {
  streamId: string;
}

const POLL_MS = 12_000;

/**
 * "N just added to cart" pill, polled every ~12s from
 * GET /api/streams/[id]/ticker. Hidden entirely when the count is 0 — we never
 * show "0 just added to cart". Polling (not realtime) is deliberate: the ticker
 * is ambient social proof and doesn't need sub-second accuracy.
 */
export default function PurchaseTicker({ streamId }: PurchaseTickerProps) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      try {
        const res = await fetch(`/api/streams/${streamId}/ticker`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as { count?: number };
        if (!cancelled && typeof data.count === "number") {
          setCount(data.count);
        }
      } catch {
        // Network hiccup — keep the last known value; next tick retries.
      }
    }

    refresh();
    const interval = setInterval(refresh, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [streamId]);

  if (count <= 0) return null;

  return (
    <div className="pointer-events-none absolute bottom-[210px] left-[12px] z-10">
      <span className="inline-flex items-center gap-1 rounded-full bg-black/40 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur-sm">
        🛒 {count} just added to cart
      </span>
    </div>
  );
}
