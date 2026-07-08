"use client";

import { useEffect, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { formatNpr } from "@/lib/utils";
import type { Product, Stream } from "@/lib/types";
import BuyModal from "@/components/BuyModal";

interface PinnedProductProps {
  stream: Stream;
  initialProduct: Product | null;
}

/**
 * Watches the stream row via Supabase Realtime and updates the pinned product
 * card live (no page refresh) whenever the seller pins/unpins.
 */
export default function PinnedProduct({
  stream,
  initialProduct,
}: PinnedProductProps) {
  const supabase = createSupabaseBrowserClient();
  const [pinnedId, setPinnedId] = useState<string | null>(
    stream.pinned_product_id,
  );
  const [product, setProduct] = useState<Product | null>(initialProduct);
  const [buyOpen, setBuyOpen] = useState(false);

  useEffect(() => {
    const channel = supabase
      .channel(`stream:${stream.id}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "streams",
          filter: `id=eq.${stream.id}`,
        },
        (payload) => {
          const updated = payload.new as Stream;
          setPinnedId(updated.pinned_product_id);
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, stream.id]);

  // When pinned id changes, fetch the product details.
  useEffect(() => {
    if (!pinnedId) {
      setProduct(null);
      return;
    }
    if (product?.id === pinnedId) return;
    (async () => {
      const { data } = await supabase
        .from("products")
        .select("*")
        .eq("id", pinnedId)
        .single();
      setProduct((data as Product) ?? null);
    })();
  }, [pinnedId, product?.id, supabase]);

  if (!product) {
    return (
      <div className="card p-4 text-sm text-slate-500">
        No product pinned right now.
      </div>
    );
  }

  return (
    <>
      <div className="card overflow-hidden">
        <div className="flex gap-3 p-3">
          {product.image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={product.image_url}
              alt={product.name}
              className="h-16 w-16 rounded object-cover"
            />
          ) : (
            <div className="h-16 w-16 rounded bg-slate-100 flex items-center justify-center text-slate-400">
              🛍️
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="badge bg-rose-100 text-rose-700">📌 Pinned</span>
              <span className="text-xs text-slate-500">
                {product.stock > 0 ? `${product.stock} in stock` : "Sold out"}
              </span>
            </div>
            <h3 className="font-medium truncate mt-1">{product.name}</h3>
            <p className="text-brand-700 font-semibold">
              {formatNpr(product.price_cents)}
            </p>
          </div>
        </div>
        <div className="p-3 pt-0">
          <button
            className="btn-primary w-full"
            disabled={product.stock <= 0}
            onClick={() => setBuyOpen(true)}
          >
            {product.stock > 0 ? "Buy now" : "Sold out"}
          </button>
        </div>
      </div>
      <BuyModal
        open={buyOpen}
        onClose={() => setBuyOpen(false)}
        product={product}
        streamId={stream.id}
      />
    </>
  );
}
