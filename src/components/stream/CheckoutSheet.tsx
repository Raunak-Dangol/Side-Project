"use client";

import { useEffect, useState } from "react";
import { formatNpr } from "@/lib/utils";
import { haptic } from "@/lib/haptics";
import type { Product, PaymentGateway, ShippingAddress } from "@/lib/types";
import { useAuthInterceptor } from "@/components/auth/AuthInterceptorProvider";

interface CheckoutSheetProps {
  open: boolean;
  onClose: () => void;
  product: Product;
  streamId: string;
}

/** Per-buyer memory of the last gateway used, so the radio pre-selects it. */
const GATEWAY_STORAGE_KEY = "live-shop:last-gateway";
const MAX_QTY = 99;

/**
 * Bottom-sheet checkout overlay (plan §4). A RE-SKIN of the legacy BuyModal —
 * the `startCheckout` money flow is preserved verbatim:
 *   POST /api/checkout/initiate ->
 *     Khalti: window.location.href = paymentUrl
 *     eSewa:  inject the hidden auto-submitting form and submit it
 * No payment verification logic lives here; the callback routes + fulfill_order
 * RPC (now qty-aware via migration 0009) handle that.
 *
 * Phase 3 §4 additions:
 *   - Quantity stepper (1..min(stock, 99)). Live total = price x qty, taken from
 *     the server's response (the server recomputes amount anyway, so the CTA is
 *     a display mirror, not a source of truth).
 *   - Optional shipping address (name/phone/line1/city). Persisted on the order.
 *   - Gateway radio cards (Khalti / eSewa) with the last-used pre-selected via
 *     localStorage.
 *   - Failure matrix (§9.B): sold-out-before-tap disables the CTA; a 409 from
 *     initiate surfaces "Just sold out"; cancel/return preserves sheet state via
 *     the auth-interceptor intent-replay; gateway timeout relies on the Phase-2
 *     webhook + return-page polling.
 *
 * Guest gate (P2-D): the money flow itself is untouched — this gate only blocks
 * the *trigger*. An anon viewer who taps Buy gets the auth sheet; once signed
 * in, the stream view's intent replay re-opens this sheet on the same product.
 *
 * The sheet stays on the warm light theme (decision: light sheet on dark stream)
 * so it reads as a familiar e-commerce surface against the cinema canvas.
 */
export default function CheckoutSheet({
  open,
  onClose,
  product,
  streamId,
}: CheckoutSheetProps) {
  const [quantity, setQuantity] = useState(1);
  const [gateway, setGateway] = useState<PaymentGateway>("khalti");
  const [address, setAddress] = useState<ShippingAddress>({
    name: "",
    phone: "",
    line1: "",
    city: "",
  });
  const [addressOpen, setAddressOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSoldOut, setJustSoldOut] = useState(false);
  const { requireAuth } = useAuthInterceptor();

  // Reset transient flags when the sheet re-opens. Tracking the previous `open`
  // prop and resetting during render is the React "adjust state during render"
  // escape hatch (react.dev/reference/react/useState#storing-information-from-
  // previous-renders): cheaper than a commit-phase effect, and the reset lands
  // before the JSX below ever reads these flags on the new open cycle.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setError(null);
      setJustSoldOut(false);
    }
  }

  // Pre-select the last-used gateway on open. localStorage is a side-effecting
  // external store (private mode can throw), so this genuinely belongs in an
  // effect rather than render.
  useEffect(() => {
    if (!open) return;
    /* eslint-disable react-hooks/set-state-in-effect -- mirrors a value from
     * an external store (localStorage) into component state. The whole point
     * of the effect is the side-effecting read; the setState is the harvest,
     * not derivable during render (private mode can throw mid-read). */
    try {
      const saved = window.localStorage.getItem(GATEWAY_STORAGE_KEY);
      if (saved === "khalti" || saved === "esewa") setGateway(saved);
    } catch {
      // localStorage unavailable (private mode) -- default stays.
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open]);

  if (!open) return null;

  const soldOut = product.stock <= 0;
  const maxQty = Math.min(MAX_QTY, Math.max(1, product.stock));
  const unitPrice = product.price_cents;
  const total = unitPrice * quantity;

  function adjustQty(delta: number) {
    setQuantity((q) => {
      const next = Math.max(1, Math.min(maxQty, q + delta));
      if (next !== q) haptic(10);
      return next;
    });
  }

  function selectGateway(g: PaymentGateway) {
    if (g === gateway) return;
    setGateway(g);
    haptic(10);
    try {
      window.localStorage.setItem(GATEWAY_STORAGE_KEY, g);
    } catch {
      // best-effort
    }
  }

  async function startCheckout() {
    setError(null);
    setJustSoldOut(false);
    // Guest gate: bail (and open the auth sheet) before touching the payment
    // flow. The money path below never runs for anon viewers.
    if (!requireAuth({ kind: "buy", productId: product.id, streamId })) {
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/checkout/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: product.id,
          streamId,
          gateway,
          quantity,
          // Send the address only if the buyer filled at least one field; the
          // server accepts null for digital / pick-up-only orders.
          shippingAddress: hasAnyAddress(address) ? address : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        // §9.B: a 409 here means sold out between tapping the card and the
        // initiate call. Surface "Just sold out" and stop.
        if (res.status === 409) setJustSoldOut(true);
        throw new Error(data.error ?? "Checkout failed");
      }

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
      setLoading(false);
    }
  }

  // Disabled when: sold out, just sold out, or a checkout is in-flight.
  const ctaDisabled = soldOut || justSoldOut || loading;

  return (
    // Backdrop closes the sheet on click. z-modal sits above every other overlay.
    <div
      className="absolute inset-0 z-modal flex items-end bg-black/50"
      onClick={onClose}
    >
      {/* The sheet itself stops propagation so taps inside don't close it. */}
      <div
        style={{ animation: "sheet-slide-up 300ms ease-out" }}
        className="w-full rounded-t-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-200" />

        {/* Header: thumbnail + name + unit price */}
        <div className="flex items-start gap-3">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-slate-100">
            {product.image_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={product.image_url}
                alt={product.name}
                className="h-full w-full object-cover"
              />
            ) : (
              <span className="text-2xl">🛍️</span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-semibold text-lg text-ink">
              {product.name}
            </h2>
            <p className="mt-0.5 inline-block rounded bg-gold-50 px-1.5 py-0.5 font-semibold text-gold-dark">
              {formatNpr(unitPrice)}
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

        {/* Quantity stepper */}
        <div className="mt-4 flex items-center justify-between">
          <span className="text-sm text-slate-600">Quantity</span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label="Decrease quantity"
              onClick={() => adjustQty(-1)}
              disabled={quantity <= 1 || loading}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-300 text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"
            >
              −
            </button>
            <span className="w-6 text-center font-medium text-ink">{quantity}</span>
            <button
              type="button"
              aria-label="Increase quantity"
              onClick={() => adjustQty(1)}
              disabled={quantity >= maxQty || loading}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-300 text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"
            >
              +
            </button>
          </div>
        </div>
        {product.stock <= 5 && product.stock > 0 ? (
          <p className="mt-1 text-right text-[11px] font-medium text-amber-700">
            Only {product.stock} left!
          </p>
        ) : null}

        {/* Shipping address (collapsible) */}
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setAddressOpen((v) => !v)}
            className="flex w-full items-center justify-between text-sm text-slate-600"
            aria-expanded={addressOpen}
          >
            <span>
              {hasAnyAddress(address) ? "📦 Shipping address" : "📦 Add shipping address (optional)"}
            </span>
            <span className="text-slate-400">{addressOpen ? "▲" : "▼"}</span>
          </button>
          {addressOpen ? (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <input
                className="input col-span-1"
                placeholder="Full name"
                value={address.name}
                onChange={(e) => setAddress((a) => ({ ...a, name: e.target.value }))}
                disabled={loading}
              />
              <input
                className="input col-span-1"
                placeholder="Phone"
                value={address.phone}
                onChange={(e) => setAddress((a) => ({ ...a, phone: e.target.value }))}
                disabled={loading}
              />
              <input
                className="input col-span-2"
                placeholder="Address line"
                value={address.line1}
                onChange={(e) => setAddress((a) => ({ ...a, line1: e.target.value }))}
                disabled={loading}
              />
              <input
                className="input col-span-2"
                placeholder="City"
                value={address.city}
                onChange={(e) => setAddress((a) => ({ ...a, city: e.target.value }))}
                disabled={loading}
              />
            </div>
          ) : null}
        </div>

        {/* Gateway radio cards */}
        <div className="mt-4 space-y-2">
          <GatewayCard
            selected={gateway === "khalti"}
            onSelect={() => selectGateway("khalti")}
            icon="💳"
            label="Khalti"
            disabled={loading}
          />
          <GatewayCard
            selected={gateway === "esewa"}
            onSelect={() => selectGateway("esewa")}
            icon="🟢"
            label="eSewa"
            disabled={loading}
          />
        </div>

        {/* Price summary */}
        <div className="mt-4 flex items-center justify-between border-t border-slate-200 pt-3">
          <span className="text-sm text-slate-600">
            Total{quantity > 1 ? ` (${quantity} × ${formatNpr(unitPrice)})` : ""}
          </span>
          <span className="font-semibold text-ink">{formatNpr(total)}</span>
        </div>

        {/* CTA — label reflects the live total + selected gateway. */}
        <button
          type="button"
          onClick={startCheckout}
          disabled={ctaDisabled}
          className="btn-primary mt-3 w-full"
        >
          {loading
            ? "Redirecting…"
            : justSoldOut
              ? "Just sold out"
              : soldOut
                ? "Sold out"
                : `Pay ${formatNpr(total)} via ${gateway === "khalti" ? "Khalti" : "eSewa"}`}
        </button>

        {error ? <p className="mt-3 text-sm text-rose-600">{error}</p> : null}
        <p className="mt-2 text-center text-[11px] text-slate-400">
          Secure NPR payment via Nepali gateway.
        </p>
      </div>
    </div>
  );
}

function GatewayCard({
  selected,
  onSelect,
  icon,
  label,
  disabled,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: string;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      style={selected ? { animation: "card-pop 180ms ease-out" } : undefined}
      className={[
        "flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition",
        selected
          ? "border-primary bg-primary-50 ring-1 ring-primary"
          : "border-slate-300 bg-white hover:bg-slate-50",
        disabled ? "opacity-60" : "",
      ].join(" ")}
      aria-pressed={selected}
    >
      <span className="text-xl" aria-hidden>{icon}</span>
      <span className="flex-1 font-medium text-ink">{label}</span>
      <span
        className={[
          "flex h-4 w-4 items-center justify-center rounded-full border",
          selected ? "border-primary bg-primary" : "border-slate-300",
        ].join(" ")}
        aria-hidden
      >
        {selected ? <span className="h-1.5 w-1.5 rounded-full bg-white" /> : null}
      </span>
    </button>
  );
}

function hasAnyAddress(a: ShippingAddress): boolean {
  return Boolean(a.name || a.phone || a.line1 || a.city);
}
