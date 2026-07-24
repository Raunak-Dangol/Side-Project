import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { formatNpr } from "@/lib/utils";
import type { Order, OrderStatus, Product, Stream } from "@/lib/types";
import OrderStatusPoller from "@/components/checkout/OrderStatusPoller";
import ReconciliationCard from "./ReconciliationCard";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ status?: string; orderId?: string }>;
}

const STATUS_COPY: Record<string, { title: string; body: string; tone: string }> = {
  paid: {
    title: "Payment successful 🎉",
    body: "Your order is confirmed. The seller has been notified.",
    tone: "emerald",
  },
  pending: {
    title: "Payment pending",
    body: "Your payment is still processing. This page will update automatically when it confirms — no need to refresh.",
    tone: "amber",
  },
  failed: {
    title: "Payment failed",
    body: "Your payment didn't complete. No charge was finalized.",
    tone: "rose",
  },
  oversold: {
    title: "Sold out",
    body: "The item sold out just before your payment completed. Please contact the seller for a refund.",
    tone: "rose",
  },
  amount_mismatch: {
    title: "Payment rejected",
    body: "The returned amount didn't match the order. The order was rejected for your safety.",
    tone: "rose",
  },
  bad_signature: {
    title: "Payment rejected",
    body: "The payment callback failed verification. The order was rejected.",
    tone: "rose",
  },
  lookup_failed: {
    title: "Couldn't confirm payment",
    body: "We couldn't reach the gateway to confirm your payment. If you were charged, please contact the seller.",
    tone: "amber",
  },
  not_found: {
    title: "Order not found",
    body: "We couldn't find an order matching this checkout.",
    tone: "rose",
  },
  error: {
    title: "Payment processing error",
    body: "Something went wrong while confirming your payment. If you were charged, please contact the seller with your order ID.",
    tone: "rose",
  },
  invalid: {
    title: "Invalid callback",
    body: "The payment callback was missing required information.",
    tone: "rose",
  },
};

/**
 * Maps a polled `OrderStatus` to the same `status` string the page uses for its
 * `STATUS_COPY` lookup. `oversold` is a server-derived status (paid + needs_refund),
 * not an OrderStatus literal, so it's synthesized here.
 */
function statusKeyFromOrder(s: OrderStatus, needsRefund: boolean): string {
  if (s === "paid" && needsRefund) return "oversold";
  return s; // paid / pending / failed map directly
}

export default async function CheckoutReturnPage({ searchParams }: PageProps) {
  const { status = "invalid", orderId } = await searchParams;
  const copy = STATUS_COPY[status] ?? STATUS_COPY.invalid;

  const supabase = await createSupabaseServerClient();

  let order: Order | null = null;
  let product: Product | null = null;
  let stream: Stream | null = null;

  if (orderId) {
    const { data: orderRow } = await supabase
      .from("orders")
      .select("*")
      .eq("id", orderId)
      .single();
    order = (orderRow as Order | null) ?? null;

    if (order) {
      const { data: p } = await supabase
        .from("products")
        .select("*")
        .eq("id", order.product_id)
        .single();
      product = (p as Product | null) ?? null;

      const { data: s } = await supabase
        .from("streams")
        .select("*")
        .eq("id", order.stream_id)
        .single();
      stream = (s as Stream | null) ?? null;
    }
  }

  const tone =
    {
      emerald: "bg-emerald-50 border-emerald-200 text-emerald-900",
      amber: "bg-amber-50 border-amber-200 text-amber-900",
      rose: "bg-rose-50 border-rose-200 text-rose-900",
    }[copy.tone] ?? "bg-rose-50 border-rose-200 text-rose-900";

  return (
    <div className="mx-auto max-w-md px-4 py-12">
      <ReconciliationCard
        initialStatusKey={status}
        initialTone={tone}
        initialTitle={copy.title}
        initialBody={copy.body}
      >
        {/* The poller renders nothing; it reconciles the card above via its
            onReconciled callback once the order row flips out of `pending`. */}
        {order ? (
          <OrderStatusPoller
            orderId={order.id}
            initialStatus={order.status}
            onReconciled={(s, needsRefund) => {
              const key = statusKeyFromOrder(s, needsRefund);
              const ev = new CustomEvent("order-status-reconciled", {
                detail: { key, copy: STATUS_COPY[key] ?? STATUS_COPY.invalid },
              });
              window.dispatchEvent(ev);
            }}
          />
        ) : null}
      </ReconciliationCard>

      {order && product ? (
        <div className="card p-4 mt-4 text-sm">
          <h2 className="font-medium mb-2">Order details</h2>
          <dl className="space-y-1 text-slate-600">
            <div className="flex justify-between">
              <dt>Product</dt>
              <dd className="font-medium text-slate-900">{product.name}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Amount</dt>
              <dd className="font-medium text-slate-900">
                {formatNpr(order.amount_cents)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt>Gateway</dt>
              <dd className="font-medium text-slate-900 capitalize">
                {order.payment_gateway}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt>Status</dt>
              <dd className="font-medium text-slate-900">{order.status}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Reference</dt>
              <dd className="font-mono text-xs text-slate-500">
                {order.gateway_transaction_id ?? "—"}
              </dd>
            </div>
          </dl>
        </div>
      ) : null}

      <div className="mt-6 flex gap-2">
        {stream ? (
          <Link href={`/stream/${stream.id}`} className="btn-secondary">
            Back to stream
          </Link>
        ) : null}
        <Link href="/" className="btn-primary">
          Browse streams
        </Link>
      </div>

      {/* TODO (post-prototype): email receipt + order history page for buyers */}
    </div>
  );
}

