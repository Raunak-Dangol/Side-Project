"use client";

import { useEffect, useState } from "react";
import Confetti from "@/components/checkout/Confetti";

interface ReconciliationCardProps {
  initialStatusKey: string;
  initialTone: string;
  initialTitle: string;
  initialBody: string;
  /**
   * Children render alongside the card — used to host the `<OrderStatusPoller>`
   * (which renders nothing but calls back via the `order-status-reconciled`
   * window event the page dispatches in its `onReconciled`).
   */
  children?: React.ReactNode;
}

const TONE_MAP: Record<string, string> = {
  emerald: "bg-emerald-50 border-emerald-200 text-emerald-900",
  amber: "bg-amber-50 border-amber-200 text-amber-900",
  rose: "bg-rose-50 border-rose-200 text-rose-900",
};

/**
 * Client-side status card for the checkout return page. The server renders the
 * initial copy (from the redirect's `status` param); this client component
 * listens for a `order-status-reconciled` event (dispatched by the page when
 * the status poller observes the order flip out of `pending`) and swaps the
 * title/body/tone to match. Lets us avoid plumbing the poller's callbacks as
 * React props across the server/client boundary.
 *
 * P3-D: fires CSS confetti when the displayed status is `paid` — either on
 * initial load (the redirect callback already confirmed payment) or when a
 * pending order reconciles to paid via the webhook. The confetti is gated by
 * `prefers-reduced-motion` inside the Confetti component itself.
 */
export default function ReconciliationCard({
  initialStatusKey,
  initialTone,
  initialTitle,
  initialBody,
  children,
}: ReconciliationCardProps) {
  const [tone, setTone] = useState(initialTone);
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const [statusKey, setStatusKey] = useState(initialStatusKey);
  const [reconciled, setReconciled] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        key: string;
        copy: { title: string; body: string; tone: string };
      };
      if (!detail?.copy) return;
      setTitle(detail.copy.title);
      setBody(detail.copy.body);
      setTone(TONE_MAP[detail.copy.tone] ?? TONE_MAP.rose);
      setStatusKey(detail.key);
      setReconciled(true);
    };
    window.addEventListener("order-status-reconciled", handler);
    return () => {
      window.removeEventListener("order-status-reconciled", handler);
    };
  }, []);

  // Fire confetti only on a paid outcome (initial or reconciled). Oversold is
  // explicitly NOT a celebration even though the payment succeeded.
  const paid = statusKey === "paid";

  return (
    <>
      <Confetti active={paid} />
      <div className={`card border p-6 ${tone}`}>
        <h1 className="text-xl font-semibold mb-1">{title}</h1>
        <p className="text-sm opacity-90">{body}</p>
        {reconciled ? (
          <p className="mt-2 text-xs opacity-60">Updated just now.</p>
        ) : null}
      </div>
      {children}
    </>
  );
}
