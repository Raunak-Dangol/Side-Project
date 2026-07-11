"use client";

import { useState } from "react";
import { formatNpr } from "@/lib/utils";
import type { Product, PaymentGateway } from "@/lib/types";

interface CheckoutSheetProps {
  open: boolean;
  onClose: () => void;
  product: Product;
  streamId: string;
}

/**
 * Bottom-sheet checkout overlay. This is a RE-SKIN of the legacy BuyModal: the
 * `startCheckout` logic below is lifted verbatim from BuyModal.tsx —
 *   POST /api/checkout/initiate →
 *     Khalti: window.location.href = paymentUrl
 *     eSewa:  inject the hidden auto-submitting form and submit it
 * No payment logic was rewritten; only the container (slide-up sheet vs centered
 * modal) and its close affordances changed. The actual payment verification,
 * stock decrement, and order transition all happen in the untouched callback
 * routes — this component only kicks off the redirect.
 */
export default function CheckoutSheet({
  open,
  onClose,
  product,
  streamId,
}: CheckoutSheetProps) {
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
    // Backdrop closes the sheet on click. z-50 sits above every other overlay.
    <div
      className="absolute inset-0 z-50 flex items-end bg-black/50"
      onClick={onClose}
    >
      {/* The sheet itself stops propagation so taps inside don't close it. */}
      <div
        // Slides up from translateY(100%) to 0 on mount via the sheet-slide-up
        // keyframe (300ms ease-out), matching the spec's bottom-sheet motion.
        style={{ animation: "sheet-slide-up 300ms ease-out" }}
        className="w-full rounded-t-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-200" />
        <div className="flex items-start justify-between">
          <div>
            <h2 className="font-semibold text-lg text-slate-900">
              {product.name}
            </h2>
            <p className="font-semibold text-brand-700">
              {formatNpr(product.price_cents)}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 transition hover:text-slate-600"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <p className="mb-4 mt-3 text-sm text-slate-500">
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

        {error ? <p className="mt-3 text-sm text-rose-600">{error}</p> : null}
      </div>
    </div>
  );
}
