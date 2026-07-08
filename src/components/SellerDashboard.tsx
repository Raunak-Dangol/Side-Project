"use client";

import Link from "next/link";
import { useState } from "react";
import ProductForm from "@/components/ProductForm";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { formatNpr } from "@/lib/utils";
import type { Product, Profile, Stream } from "@/lib/types";

interface Props {
  profile: Profile | null;
  products: Product[];
  streams: Stream[];
}

export default function SellerDashboard({ profile, products, streams }: Props) {
  const supabase = createSupabaseBrowserClient();
  const [productList, setProductList] = useState<Product[]>(products);
  const [streamList, setStreamList] = useState<Stream[]>(streams);
  const [editing, setEditing] = useState<Product | null>(null);
  const [showProductForm, setShowProductForm] = useState(false);
  const [showStreamForm, setShowStreamForm] = useState(false);
  const [streamTitle, setStreamTitle] = useState("");
  const [pinningStreamId, setPinningStreamId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refreshProducts() {
    const { data } = await supabase
      .from("products")
      .select("*")
      .order("created_at", { ascending: false });
    setProductList((data as Product[] | null) ?? []);
  }

  async function refreshStreams() {
    const { data } = await supabase
      .from("streams")
      .select("*")
      .order("created_at", { ascending: false });
    setStreamList((data as Stream[] | null) ?? []);
  }

  async function deleteProduct(id: string) {
    if (!confirm("Delete this product?")) return;
    const { error } = await supabase.from("products").delete().eq("id", id);
    if (error) {
      setError(error.message);
      return;
    }
    await refreshProducts();
  }

  async function createStream(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!streamTitle.trim()) return;
    const roomName = `stream-${crypto.randomUUID()}`;
    const { data, error } = await supabase
      .from("streams")
      .insert({
        seller_id: profile!.id,
        title: streamTitle.trim(),
        livekit_room_name: roomName,
        status: "scheduled",
      })
      .select("*")
      .single();
    if (error) {
      setError(error.message);
      return;
    }
    setStreamTitle("");
    setShowStreamForm(false);
    setStreamList((prev) => [data as Stream, ...prev]);
  }

  async function setStatus(stream: Stream, status: Stream["status"]) {
    const { data, error } = await supabase
      .from("streams")
      .update({ status })
      .eq("id", stream.id)
      .select("*")
      .single();
    if (error) {
      setError(error.message);
      return;
    }
    setStreamList((prev) =>
      prev.map((s) => (s.id === stream.id ? (data as Stream) : s)),
    );
  }

  async function pinProduct(stream: Stream, productId: string | null) {
    setPinningStreamId(stream.id);
    setError(null);
    // POST through the API route (server-side ownership check + validation).
    const res = await fetch("/api/pin-product", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        streamId: stream.id,
        productId,
      }),
    });
    setPinningStreamId(null);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Failed to pin product");
      return;
    }
    const updated = (await res.json()) as Stream;
    setStreamList((prev) =>
      prev.map((s) => (s.id === stream.id ? updated : s)),
    );
  }

  const liveStream = streamList.find((s) => s.status === "live");

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Seller dashboard</h1>
          <p className="text-sm text-slate-500">
            Manage products, start a stream, and pin products while live.
          </p>
        </div>
      </div>

      {profile && profile.role === "buyer" ? (
        <div className="card p-4 mb-6 bg-amber-50 border-amber-200">
          <p className="text-sm text-amber-900">
            You&rsquo;re signed in as a <strong>buyer</strong>. You can create
            products and streams, but your profile role isn&rsquo;t set to
            &ldquo;seller&rdquo; yet. RLS still allows you to manage your own
            data.
          </p>
          <button
            className="btn-primary mt-3"
            onClick={async () => {
              await supabase
                .from("profiles")
                .update({ role: "seller" })
                .eq("id", profile.id);
              window.location.reload();
            }}
          >
            Become a seller
          </button>
        </div>
      ) : null}

      {error ? (
        <div className="card p-3 mb-4 bg-rose-50 border-rose-200 text-sm text-rose-700">
          {error}
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ─── Products ─── */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">Products ({productList.length})</h2>
            <button
              className="btn-secondary !py-1.5"
              onClick={() => {
                setEditing(null);
                setShowProductForm((v) => !v);
              }}
            >
              {showProductForm ? "Cancel" : "+ Add product"}
            </button>
          </div>

          {showProductForm ? (
            <div className="card p-4 mb-3">
              <ProductForm
                product={editing}
                onSaved={async () => {
                  setShowProductForm(false);
                  setEditing(null);
                  await refreshProducts();
                }}
                onCancel={() => {
                  setShowProductForm(false);
                  setEditing(null);
                }}
              />
            </div>
          ) : null}

          <div className="space-y-2">
            {productList.length === 0 ? (
              <p className="text-sm text-slate-400">No products yet.</p>
            ) : (
              productList.map((p) => (
                <div key={p.id} className="card p-3 flex items-center gap-3">
                  {p.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.image_url}
                      alt={p.name}
                      className="h-12 w-12 rounded object-cover"
                    />
                  ) : (
                    <div className="h-12 w-12 rounded bg-slate-100 flex items-center justify-center">
                      🛍️
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{p.name}</p>
                    <p className="text-xs text-slate-500">
                      {formatNpr(p.price_cents)} · {p.stock} in stock
                    </p>
                  </div>
                  <button
                    className="text-xs text-brand-700 hover:underline"
                    onClick={() => {
                      setEditing(p);
                      setShowProductForm(true);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    className="text-xs text-rose-600 hover:underline"
                    onClick={() => deleteProduct(p.id)}
                  >
                    Delete
                  </button>
                </div>
              ))
            )}
          </div>
        </section>

        {/* ─── Streams ─── */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">Streams ({streamList.length})</h2>
            <button
              className="btn-secondary !py-1.5"
              onClick={() => setShowStreamForm((v) => !v)}
            >
              {showStreamForm ? "Cancel" : "+ New stream"}
            </button>
          </div>

          {showStreamForm ? (
            <form onSubmit={createStream} className="card p-4 mb-3 space-y-3">
              <input
                className="input"
                placeholder="Stream title"
                value={streamTitle}
                onChange={(e) => setStreamTitle(e.target.value)}
                required
                maxLength={120}
              />
              <button type="submit" className="btn-primary">
                Create stream
              </button>
            </form>
          ) : null}

          <div className="space-y-3">
            {streamList.length === 0 ? (
              <p className="text-sm text-slate-400">No streams yet.</p>
            ) : (
              streamList.map((s) => (
                <div key={s.id} className="card p-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <Link
                        href={`/stream/${s.id}`}
                        className="font-medium hover:underline"
                      >
                        {s.title}
                      </Link>
                      <p className="text-xs text-slate-500 mt-0.5">
                        Status:{" "}
                        <span className="font-medium">{s.status}</span>
                      </p>
                    </div>
                    <div className="flex gap-1">
                      {s.status === "scheduled" ? (
                        <button
                          className="btn-primary !py-1.5 !px-3 text-xs"
                          onClick={() => setStatus(s, "live")}
                        >
                          Go live
                        </button>
                      ) : null}
                      {s.status === "live" ? (
                        <>
                          <Link
                            href={`/stream/${s.id}`}
                            className="btn-secondary !py-1.5 !px-3 text-xs"
                          >
                            Open
                          </Link>
                          <button
                            className="btn-danger !py-1.5 !px-3 text-xs"
                            onClick={() => setStatus(s, "ended")}
                          >
                            End
                          </button>
                        </>
                      ) : null}
                    </div>
                  </div>

                  {/* Pin controls — only shown while live */}
                  {s.status === "live" ? (
                    <div className="mt-3 border-t border-slate-100 pt-3">
                      <label className="block text-xs font-medium text-slate-600 mb-1">
                        Pinned product
                      </label>
                      <select
                        className="input"
                        value={s.pinned_product_id ?? ""}
                        disabled={pinningStreamId === s.id}
                        onChange={(e) =>
                          pinProduct(s, e.target.value || null)
                        }
                      >
                        <option value="">— None —</option>
                        {productList.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({formatNpr(p.price_cents)})
                          </option>
                        ))}
                      </select>
                      <p className="text-[11px] text-slate-400 mt-1">
                        Changing this updates the pinned card for all viewers in
                        real time.
                      </p>
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>

          {liveStream ? (
            <div className="card p-3 mt-4 bg-rose-50 border-rose-200 text-sm text-rose-800">
              You&rsquo;re currently live:{" "}
              <Link href={`/stream/${liveStream.id}`} className="underline">
                {liveStream.title}
              </Link>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
