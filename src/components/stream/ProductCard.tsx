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
  return (
    <div className="absolute bottom-[150px] right-[12px] z-10 flex w-[96px] flex-col overflow-hidden rounded-lg bg-white/95 shadow-lg backdrop-blur-sm">
      <button
        type="button"
        onClick={onBuy}
        className="flex flex-col text-left"
        aria-label={`Buy ${product.name}`}
      >
        <div className="flex h-[72px] w-full items-center justify-center overflow-hidden bg-slate-100">
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
        </div>
        <div className="px-1.5 pt-1">
          <p className="truncate text-[11px] font-medium leading-tight text-slate-900">
            {product.name}
          </p>
          <p className="text-[11px] font-semibold text-brand-700">
            {formatNpr(product.price_cents)}
          </p>
        </div>
      </button>
      <button
        type="button"
        onClick={onBuy}
        disabled={soldOut}
        className="m-1.5 mt-1 rounded bg-brand-600 px-2 py-1 text-[11px] font-medium text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {soldOut ? "Sold out" : "Buy"}
      </button>
    </div>
  );
}
