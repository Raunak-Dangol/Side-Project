"use client";

import { useEffect, useRef, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { removeChannelSilently } from "@/lib/realtime-cleanup";
import { formatNpr } from "@/lib/utils";

interface Props {
  streamId: string;
}

interface TelemetrySnapshot {
  gmv_cents: number;
  units_sold: number;
  orders_count: number;
  conversion_rate: number;
  viewer_count: number;
}

/**
 * Live sales telemetry (Phase 4 / P4-B). Renders four cards:
 *
 *   GMV · Units sold · Orders · Conversion rate
 *
 * Initial values come from GET /api/seller/telemetry (the seller-only
 * snapshot endpoint). The cards then tick LIVE as sales land — a Supabase
 * realtime subscription on `orders` (status='paid') for this stream
 * increments GMV / units / orders the moment a sale is confirmed, not on a
 * poll. viewer_count comes from the existing `stream:viewers:${stream.id}`
 * presence channel (the same one StreamView uses) — no separate poll loop.
 *
 * Values are rendered directly (no count-up tween): per-sale increments are
 * frequent enough that a tween would replay history on every INSERT, and
 * prefers-reduced-motion would collapse it to instant in any case.
 */
export default function SalesTelemetry({ streamId }: Props) {
  const supabase = createSupabaseBrowserClient();
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Live view of the current paid-order contributions, kept in refs so the
  // realtime callback can increment them without re-subscribing on every
  // render. The displayed numbers are the tweened values from <CountUp>.
  const liveRef = useRef({
    gmv_cents: 0,
    units_sold: 0,
    orders_count: 0,
  });
  const [viewerCount, setViewerCount] = useState(0);

  // ── initial snapshot ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(
        `/api/seller/telemetry?streamId=${encodeURIComponent(streamId)}`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        if (!cancelled) setError("Couldn't load telemetry.");
        return;
      }
      const data = (await res.json()) as TelemetrySnapshot;
      if (cancelled) return;
      setSnapshot(data);
      liveRef.current = {
        gmv_cents: data.gmv_cents,
        units_sold: data.units_sold,
        orders_count: data.orders_count,
      };
      setViewerCount(data.viewer_count);
    })();
    return () => {
      cancelled = true;
    };
  }, [streamId]);

  // ── live order increments ─────────────────────────────────────────────────
  // Subscribe to paid-order INSERTs on this stream. Each new paid order bumps
  // GMV by amount_cents, units by quantity, and orders by 1. We can't trust
  // payload.new.amount_cents alone for the GMV unless we know it's paid — the
  // filter `status=eq.paid` enforces that at the Postgres level.
  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;

    (async () => {
      channel = supabase
        .channel(`seller-telemetry:${streamId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "orders",
            filter: `stream_id=eq.${streamId}`,
          },
          (payload) => {
            const row = payload.new as {
              status: string;
              amount_cents: number;
              quantity: number;
            };
            // The filter on `stream_id` is exact; the `status=eq.paid`
            // filter isn't expressible in a single realtime filter clause
            // alongside stream_id (supabase-js allows only one filter),
            // so we gate on the row's status here.
            if (row.status !== "paid") return;
            liveRef.current = {
              gmv_cents: liveRef.current.gmv_cents + row.amount_cents,
              units_sold: liveRef.current.units_sold + row.quantity,
              orders_count: liveRef.current.orders_count + 1,
            };
            // Push the new totals into <CountUp> by bumping the snapshot.
            setSnapshot((prev) =>
              prev
                ? {
                    ...prev,
                    gmv_cents: liveRef.current.gmv_cents,
                    units_sold: liveRef.current.units_sold,
                    orders_count: liveRef.current.orders_count,
                  }
                : prev,
            );
          },
        )
        .subscribe();

      if (cancelled) {
        void removeChannelSilently(supabase, channel);
      }
    })();

    return () => {
      cancelled = true;
      void removeChannelSilently(supabase, channel);
    };
  }, [supabase, streamId]);

  // ── viewer count from the presence channel ─────────────────────────────────
  // Tap into the SAME `stream:viewers:${stream.id}` presence channel
  // StreamView uses, but as a separate channel instance with our own
  // presence key (we don't track — we just sync on the presence state). This
  // avoids a poll loop entirely: viewer_count updates the moment someone
  // joins/leaves. The channel doesn't track presence itself (an observer
  // that never tracks still receives sync events with the full state).
  useEffect(() => {
    if (!snapshot) return; // wait for the initial viewer_count from snapshot
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;

    (async () => {
      channel = supabase.channel(`stream:viewers:${streamId}`, {
        config: { presence: { key: `seller-telemetry-${streamId}` } },
      });
      channel
        .on("presence", { event: "sync" }, () => {
          const state = channel!.presenceState();
          setViewerCount(Object.keys(state).length);
        })
        .subscribe(async (status) => {
          // Track an inert presence so this client counts in the sync too —
          // matches StreamView's accounting (the seller watching their own
          // preview is a viewer of their stream for the counter's purposes).
          if (status === "SUBSCRIBED") {
            await channel!.track({
              id: `seller-telemetry-${streamId}`,
              joined_at: Date.now(),
            });
          }
        });
      if (cancelled) {
        void removeChannelSilently(supabase, channel);
      }
    })();

    return () => {
      cancelled = true;
      void removeChannelSilently(supabase, channel);
    };
  }, [supabase, streamId, snapshot]);

  if (error) {
    return (
      <p className="text-sm text-rose-600" role="alert">
        {error}
      </p>
    );
  }

  if (!snapshot) {
    return (
      <div className="grid grid-cols-2 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card p-4 animate-pulse-soft">
            <div className="h-3 w-16 rounded bg-slate-100" />
            <div className="mt-2 h-6 w-24 rounded bg-slate-100" />
          </div>
        ))}
      </div>
    );
  }

  const conversion =
    viewerCount > 0
      ? `${((snapshot.orders_count / viewerCount) * 100).toFixed(1)}%`
      : "—";

  return (
    <div className="grid grid-cols-2 gap-3">
      <TelemetryCard label="GMV" value={formatNpr(snapshot.gmv_cents)} />
      <TelemetryCard label="Units sold" value={String(snapshot.units_sold)} />
      <TelemetryCard label="Orders" value={String(snapshot.orders_count)} />
      <TelemetryCard label="Live viewers" value={String(viewerCount)} />
      <div className="col-span-2 card p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Conversion rate
        </p>
        <p className="mt-1 text-2xl font-semibold text-ink">{conversion}</p>
        <p className="text-[11px] text-slate-400 mt-1">
          {snapshot.orders_count} paid order
          {snapshot.orders_count === 1 ? "" : "s"} ·{" "}
          {viewerCount} viewer{viewerCount === 1 ? "" : "s"}
        </p>
      </div>
    </div>
  );
}

interface TelemetryCardProps {
  label: string;
  value: string;
}

/**
 * Single metric card. A count-up tween is intentionally NOT used here: the
 * realtime increments are per-sale and the snapshot may already be large, so
 * a tween on every INSERT would replay the entire history. Instead the value
 * is rendered directly; the prefers-reduced-motion block in globals.css
 * neutralizes any ambient animation these cards rely on.
 */
function TelemetryCard({ label, value }: TelemetryCardProps) {
  return (
    <div className="card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold text-ink">{value}</p>
    </div>
  );
}
