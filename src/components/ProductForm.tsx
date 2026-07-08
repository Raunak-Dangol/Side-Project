"use client";

import { useState } from "react";
import type { Product } from "@/lib/types";

interface ProductFormProps {
  /** existing product when editing; null when creating */
  product?: Product | null;
  onSaved: () => void;
  onCancel: () => void;
}

export default function ProductForm({
  product,
  onSaved,
  onCancel,
}: ProductFormProps) {
  const [name, setName] = useState(product?.name ?? "");
  // price is entered in NPR (rupees) and converted to paisa on submit.
  const [priceNpr, setPriceNpr] = useState(
    product ? String(product.price_cents / 100) : "",
  );
  const [stock, setStock] = useState(
    product ? String(product.stock) : "0",
  );
  const [imageUrl, setImageUrl] = useState(product?.image_url ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);

    const priceCents = Math.round(parseFloat(priceNpr) * 100);
    if (isNaN(priceCents) || priceCents <= 0) {
      setError("Enter a valid price in NPR.");
      setSaving(false);
      return;
    }
    const stockNum = parseInt(stock, 10);
    if (isNaN(stockNum) || stockNum < 0) {
      setError("Enter a valid stock count.");
      setSaving(false);
      return;
    }

    const body = {
      name: name.trim(),
      price_cents: priceCents,
      stock: stockNum,
      image_url: imageUrl.trim() || null,
      ...(product ? { id: product.id } : {}),
    };

    const res = await fetch("/api/products", {
      method: product ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setError(err.error ?? "Failed to save product");
      setSaving(false);
      return;
    }
    setSaving(false);
    onSaved();
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-slate-600 mb-1">
          Product name
        </label>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={120}
          placeholder="e.g. Handwoven wool scarf"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">
            Price (NPR)
          </label>
          <input
            className="input"
            type="number"
            step="0.01"
            min="0"
            value={priceNpr}
            onChange={(e) => setPriceNpr(e.target.value)}
            required
            placeholder="0.00"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">
            Stock
          </label>
          <input
            className="input"
            type="number"
            min="0"
            step="1"
            value={stock}
            onChange={(e) => setStock(e.target.value)}
            required
          />
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium text-slate-600 mb-1">
          Image URL (optional)
        </label>
        <input
          className="input"
          value={imageUrl}
          onChange={(e) => setImageUrl(e.target.value)}
          placeholder="https://…"
        />
      </div>
      {error ? <p className="text-sm text-rose-600">{error}</p> : null}
      <div className="flex gap-2 justify-end">
        <button type="button" className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? "Saving…" : product ? "Save changes" : "Add product"}
        </button>
      </div>
    </form>
  );
}
