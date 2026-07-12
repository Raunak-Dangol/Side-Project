"use client";

import { useState } from "react";
import { formatNpr } from "@/lib/utils";
import type { Product, PaymentGateway } from "@/lib/types";

interface BuyModalProps {
  open: boolean;
  onClose: () => void;
  product: Product;
  streamId: string;
}

export default function BuyModal({
  open,
  onClose,
  product,
  streamId,
}: BuyModalProps) {
  const [loading, setLoading] = useState<PaymentGateway | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  async function startCheckout(gateway: PaymentGateway) {
    setError(null);
    setLoading(gateway);
    try {
      const res = await fetch("/api/checkout/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: product.id,
          streamId,
          gateway,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Checkout failed");

      if (gateway === "khalti") {
        // Khalti: redirect the browser to the payment_url.
        window.location.href = data.paymentUrl;
      } else {
        // eSewa: render the auto-submitting hidden form into the DOM and POST it.
        const form = document.createElement("div");
        form.innerHTML = data.formHtml;
        document.body.appendChild(form);
        const formEl = document.getElementById(
          "esewa-payment-form",
        ) as HTMLFormElement | null;
        formEl?.submit();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Checkout failed");
      setLoading(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="card w-full max-w-md p-5">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="font-semibold text-lg">{product.name}</h2>
            <p className="mt-0.5 inline-block rounded bg-gold-50 px-1.5 py-0.5 font-semibold text-gold-dark">
              {formatNpr(product.price_cents)}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <p className="text-sm text-slate-500 mt-3 mb-4">
          Choose a payment method. Both are NPR-only Nepali gateways.
        </p>

        <div className="space-y-2">
          <button
            className="btn-primary w-full justify-start"
            disabled={loading !== null}
            onClick={() => startCheckout("khalti")}
          >
            {loading === "khalti" ? "Redirecting…" : "💳 Pay with Khalti"}
          </button>
          <button
            className="btn w-full justify-start bg-emerald-600 text-white hover:bg-emerald-700"
            disabled={loading !== null}
            onClick={() => startCheckout("esewa")}
          >
            {loading === "esewa" ? "Redirecting…" : "🟢 Pay with eSewa"}
          </button>
        </div>

        {error ? (
          <p className="mt-3 text-sm text-rose-600">{error}</p>
        ) : null}
      </div>
    </div>
  );
}
