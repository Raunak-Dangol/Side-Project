"use client";

import { formatNpr } from "@/lib/utils";
import type { Product } from "@/lib/types";

interface ProductCardProps {
  product: Product;
  /** Called when the card body or the buy button is tapped. */
  onBuy: () => void;
}

/**
 * Bottom-right pinned product card. Presentational only — pinned-product state
 * (realtime sync) lives in StreamView. Tapping the card or its buy button opens
 * the CheckoutSheet. Hidden entirely by StreamView when there's no pinned product.
 *
 * Sized ~96×140 per the spec: thumbnail on top, name (truncated), price, and a
 * full-width buy button. Sold-out state mirrors the legacy PinnedProduct card.
 */
export default function ProductCard({ product, onBuy }: ProductCardProps) {
  const soldOut = product.stock <= 0;
  // Phase 3 §3.5: surface scarcity when stock is low (but not zero — zero is
  // the dedicated "Sold out" state below). 5 is the threshold the checkout
  // sheet also uses, so the two stay in sync.
  const scarce = product.stock > 0 && product.stock <= 5;
  return (
    <div className="absolute bottom-[150px] right-[12px] z-commerce flex w-[96px] flex-col overflow-hidden rounded-lg bg-white/95 shadow-lg backdrop-blur-sm">
      <button
        type="button"
        onClick={onBuy}
        className="flex flex-col text-left"
        aria-label={`Buy ${product.name}`}
      >
        <div className="relative flex h-[72px] w-full items-center justify-center overflow-hidden bg-slate-100">
          {product.image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={product.image_url}
              alt={product.name}
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="text-xl text-slate-400">🛍️</span>
          )}
          {soldOut ? (
            // Absolute overlay so the buyer sees the state at a glance even
            // before reading the button label.
            <span className="absolute inset-0 flex items-center justify-center bg-black/55 text-[10px] font-semibold uppercase tracking-wide text-white">
              Sold out
            </span>
          ) : null}
        </div>
        <div className="px-1.5 pt-1">
          <p className="truncate text-[11px] font-medium leading-tight text-slate-900">
            {product.name}
          </p>
          <p className="mt-0.5 inline-block rounded bg-gold-50 px-1 text-[11px] font-semibold text-gold-dark">
            {formatNpr(product.price_cents)}
          </p>
          {scarce ? (
            <p className="mt-0.5 text-[10px] font-medium text-amber-700">
              Only {product.stock} left
            </p>
          ) : null}
        </div>
      </button>
      <button
        type="button"
        onClick={onBuy}
        disabled={soldOut}
        className="m-1.5 mt-1 rounded bg-primary px-2 py-1 text-[11px] font-medium text-primary-50 transition hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-50"
      >
        {soldOut ? "Sold out" : "Buy"}
      </button>
    </div>
  );
}
