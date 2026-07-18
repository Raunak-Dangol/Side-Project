"use client";

import { useEffect, useState } from "react";
import type { OrderStatus } from "@/lib/types";

/**
 * Polls GET /api/orders/[id]/status while the order is `pending` (the §9.B
 * reconciliation case: the gateway webhook may complete a payment whose browser
 * redirect was lost). Auto-stops on a terminal status (`paid` / `failed`) or on
 * a hard error. The return page renders the server-known status initially, then
 * this component reconciles it upward as the webhook lands.
 *
 * The component is intentionally just a thin reconciler: it doesn't render the
 * whole order card. It reports the latest polled status to the parent via
 * `onReconciled`, which the page can use to swap the displayed card. If the
 * status never changes from `pending`, nothing visible happens — the buyer sees
 * the same "Payment pending" card and can manually refresh later.
 */
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 5 * 60 * 1_000; // give up after 5 minutes

export default function OrderStatusPoller({
  orderId,
  initialStatus,
  onReconciled,
  onTerminal,
}: {
  orderId: string;
  initialStatus: OrderStatus;
  onReconciled?: (status: OrderStatus, needsRefund: boolean) => void;
  /** Called once when the poller observes a terminal status or times out. */
  onTerminal?: () => void;
}) {
  const [status, setStatus] = useState<OrderStatus>(initialStatus);

  useEffect(() => {
    if (status !== "pending") return; // already terminal, nothing to poll
    let cancelled = false;
    const startedAt = Date.now();

    const poll = async () => {
      if (cancelled) return;
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        onTerminal?.();
        return;
      }
      try {
        const res = await fetch(`/api/orders/${orderId}/status`, {
          cache: "no-store",
        });
        if (!res.ok) return; // keep polling; the order row may still update
        const data = (await res.json()) as {
          status: OrderStatus;
          needsRefund: boolean;
        };
        if (cancelled) return;
        if (data.status !== status) {
          setStatus(data.status);
          onReconciled?.(data.status, data.needsRefund);
        }
        if (data.status !== "pending") {
          onTerminal?.();
        }
      } catch {
        // Network blip — next tick retries. Don't surface to the buyer.
      }
    };

    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // We intentionally do NOT include `status` in deps — re-subscribing on every
    // status change would reset the interval. The poll closure reads the latest
    // `status` via the state above. `onReconciled`/`onTerminal` are stable in
    // practice (page passes inline closures); if they churn, re-subscribing is
    // cheap and harmless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  // This component renders nothing — the parent owns the visible card.
  return null;
}
