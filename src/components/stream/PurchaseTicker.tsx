"use client";

import { useEffect, useRef, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { removeChannelSilently } from "@/lib/realtime-cleanup";

interface PurchaseTickerProps {
  streamId: string;
}

interface TickerResponse {
  count: number;
  recent: {
    buyer_name: string;
    product_name: string;
    created_at: string;
  } | null;
}

interface Pill {
  /** Stable key (created_at + counter) for reconciliation. */
  key: number;
  buyerName: string;
  productName: string;
  leaving: boolean;
}

const SEED_POLL_MS = 12_000;
const VISIBLE_MS = 3500; // pill fully visible before starting to leave
const FADE_MS = 400; // matches the pill-out keyframe
const MAX_VISIBLE_PILLS = 2; // stack at most two pills at once

/**
 * "X just bought Y" pills (plan §3.2). Two data sources:
 *   1. A ~12s poll of GET /api/streams/[id]/ticker seeds the initial pill + the
 *      rolling count (so a viewer who joins mid-stream sees recent activity).
 *   2. A Supabase Realtime subscription on `orders` INSERT for this stream
 *      delivers live pills the moment a purchase lands — no 12s wait.
 *
 * When a new purchase arrives (either path) we refresh the ticker endpoint to
 * resolve buyer-name + product-name (the realtime payload only has ids, and
 * names must come via the service-role join on the server, not the client).
 *
 * Each pill slides in from the left (pill-in), holds ~3.5s, then slides out
 * (pill-out) and unmounts. Capped at MAX_VISIBLE_PILLS; older pills start
 * leaving first. aria-hidden because the pills are ambient social proof — the
 * readable order history lives in the buyer's /orders page.
 *
 * Reduced-motion: the global media query collapses the slide to an instant
 * appearance; pills still come and go, just without travel.
 */
export default function PurchaseTicker({ streamId }: PurchaseTickerProps) {
  const supabase = createSupabaseBrowserClient();
  const [pills, setPills] = useState<Pill[]>([]);
  const [count, setCount] = useState(0);
  const seenRef = useRef<Set<string>>(new Set());
  const counterRef = useRef(0);

  // Push a pill if we haven't shown this exact (buyerName|productName|createdAt)
  // recently. Dedupe is needed because the realtime INSERT and the seed poll can
  // both surface the same purchase.
  const pushPill = (buyerName: string, productName: string, createdAt: string) => {
    const dedupeKey = `${buyerName}|${productName}|${createdAt}`;
    if (seenRef.current.has(dedupeKey)) return;
    seenRef.current.add(dedupeKey);
    // Bound the dedupe set so it can't grow unbounded over a long stream.
    if (seenRef.current.size > 50) {
      seenRef.current = new Set(Array.from(seenRef.current).slice(-25));
    }

    const key = Date.now() + counterRef.current++;
    setPills((prev) => {
      const next = [...prev, { key, buyerName, productName, leaving: false }];
      // Evict the oldest if over capacity.
      while (next.filter((p) => !p.leaving).length > MAX_VISIBLE_PILLS) {
        const idx = next.findIndex((p) => !p.leaving);
        if (idx === -1) break;
        next[idx] = { ...next[idx], leaving: true };
      }
      return next;
    });
  };

  // ── Seed poll (initial + fallback) ────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const res = await fetch(`/api/streams/${streamId}/ticker`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as TickerResponse;
        if (cancelled) return;
        setCount(data.count);
        if (data.recent) {
          pushPill(data.recent.buyer_name, data.recent.product_name, data.recent.created_at);
        }
      } catch {
        // Network hiccup — keep last known; next tick retries.
      }
    }
    refresh();
    const interval = setInterval(refresh, SEED_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [streamId]);

  // ── Realtime: live pills the moment a purchase lands ──────────────────────
  // The INSERT payload only carries order ids; we re-poll /ticker to resolve
  // buyer-name + product-name via the server-side join (names never come from
  // the client realtime channel).
  useEffect(() => {
    let cancelled = false;
    const channel = supabase
      .channel(`ticker:${streamId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "orders",
          filter: `stream_id=eq.${streamId}`,
        },
        async () => {
          if (cancelled) return;
          // Refresh the seed endpoint; it returns the freshest purchase.
          try {
            const res = await fetch(`/api/streams/${streamId}/ticker`, {
              cache: "no-store",
            });
            if (!res.ok) return;
            const data = (await res.json()) as TickerResponse;
            if (cancelled) return;
            setCount(data.count);
            if (data.recent) {
              pushPill(
                data.recent.buyer_name,
                data.recent.product_name,
                data.recent.created_at,
              );
            }
          } catch {
            // best-effort
          }
        },
      )
      .subscribe();
    return () => {
      cancelled = true;
      void removeChannelSilently(supabase, channel);
    };
  }, [streamId, supabase]);

  // ── Pill lifecycle: leave after VISIBLE_MS, unmount after +FADE_MS ────────
  useEffect(() => {
    const leaveTimers: ReturnType<typeof setTimeout>[] = [];
    const removeTimers: ReturnType<typeof setTimeout>[] = [];
    for (const pill of pills) {
      if (pill.leaving) continue;
      leaveTimers.push(
        setTimeout(() => {
          setPills((prev) =>
            prev.map((p) => (p.key === pill.key ? { ...p, leaving: true } : p)),
          );
        }, VISIBLE_MS),
      );
      removeTimers.push(
        setTimeout(() => {
          setPills((prev) => prev.filter((p) => p.key !== pill.key));
        }, VISIBLE_MS + FADE_MS),
      );
    }
    return () => {
      leaveTimers.forEach(clearTimeout);
      removeTimers.forEach(clearTimeout);
    };
  }, [pills]);

  if (pills.length === 0 && count === 0) return null;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute bottom-[210px] left-[12px] z-hud flex flex-col gap-1"
    >
      {pills.map((pill) => (
        <span
          key={pill.key}
          style={{
            animation: pill.leaving
              ? `pill-out ${FADE_MS}ms ease-out forwards`
              : `pill-in 250ms ease-out`,
          }}
          className="inline-flex w-fit max-w-[80vw] items-center gap-1.5 rounded-full bg-primary/85 px-2.5 py-1 text-[11px] font-medium text-primary-50 backdrop-blur-sm"
        >
          <span aria-hidden>🛒</span>
          <span className="truncate">
            <span className="font-semibold">{pill.buyerName}</span> just bought{" "}
            <span className="font-semibold">{pill.productName}</span>
          </span>
        </span>
      ))}
    </div>
  );
}
