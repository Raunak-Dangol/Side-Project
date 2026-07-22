"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import ProductForm from "@/components/ProductForm";
import SalesTelemetry from "@/components/seller/SalesTelemetry";
import ChatModeration from "@/components/seller/ChatModeration";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { formatNpr } from "@/lib/utils";
import type { Product, Profile, Stream } from "@/lib/types";

interface Props {
  profile: Profile | null;
  products: Product[];
  streams: Stream[];
}

type RightTab = "telemetry" | "moderation" | "catalog";

/**
 * Broadcast-studio dashboard (Phase 4 / P4-D).
 *
 *   ┌─────────────────────┬───────────────────────────────┐
 *   │  LEFT (preview +    │  RIGHT (tabbed)               │
 *   │  controls)          │   • Telemetry (SalesTelemetry)│
 *   │                     │   • Moderation  (ChatModeration)│
 *   │  if live: seller's  │   • Catalog (product CRUD +   │
 *   │   own LiveKit       │     stream create/end + pin + │
 *   │   preview + End     │     promo editor)             │
 *   │   Stream            │                               │
 *   │  if not live:       │                               │
 *   │   Go-live CTA +     │                               │
 *   │   scheduled list    │                               │
 *   └─────────────────────┴───────────────────────────────┘
 *
 * The active-prop one-connection invariant is preserved: this dashboard's
 * live preview is a SEPARATE LiveKit participant from the feed's StreamView
 * (another tab), so the seller can watch their own camera here without leaving
 * a stale participant connected on the public feed.
 *
 * Responsive: single-column on mobile, feed-first (preview on top). The
 * existing Catalog functionality (product CRUD, stream create/end, pin
 * product, PromoEditor) is moved into the Catalog tab — not rewritten.
 */
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
  const [tab, setTab] = useState<RightTab>("telemetry");

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
    const res = await fetch("/api/pin-product", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ streamId: stream.id, productId }),
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

  async function savePromo(stream: Stream, text: string, link: string) {
    setError(null);
    const res = await fetch(`/api/streams/${stream.id}/promo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ promo_banner_text: text, promo_banner_link: link }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Failed to save promo banner");
      return;
    }
    const updated = (await res.json()) as Stream;
    setStreamList((prev) =>
      prev.map((s) => (s.id === stream.id ? updated : s)),
    );
  }

  // Watch the seller's own streams row for status changes (so if the stream
  // is ended from another tab the live preview + tabs update here too).
  useEffect(() => {
    const channel = supabase
      .channel("seller-dashboard-streams")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "streams" },
        () => {
          void refreshStreams();
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase]);

  const liveStream = streamList.find((s) => s.status === "live");
  // The stream whose surface (preview + telemetry + moderation) is currently
  // bound to the dashboard. Prefer the live stream; fall back to the most
  // recent stream (scheduled or ended) so the seller sees SOMETHING in the
  // studio even when not live.
  const focusStream = liveStream ?? streamList[0] ?? null;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold">Broadcaster studio</h1>
          <p className="text-sm text-slate-500">
            Preview, watch live sales, moderate chat, and manage your catalog
            in one place.
          </p>
        </div>
        {liveStream ? (
          <Link href={`/stream/${liveStream.id}`} className="btn-secondary">
            Open public view
          </Link>
        ) : null}
      </div>

      {error ? (
        <div className="card p-3 mb-4 bg-rose-50 border-rose-200 text-sm text-rose-700">
          {error}
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-6 studio-grid">
        {/* ─── LEFT: live preview + controls ───────────────────────────── */}
        <section className="studio-left">
          {liveStream ? (
            <div className="card overflow-hidden">
              {/* Reserved preview slot: an actual LiveKit participant tile
                  (role="seller", separate from the feed's StreamView) slots
                  in here. The grid reserves the space; the broadcast-quality
                  controls (mic/camera toggles) are deferred per the plan —
                  the panel is collapsed to a placeholder + the End Stream
                  button + the open-view link. */}
              <div className="studio-preview bg-cinema flex items-center justify-center text-slate-300 text-sm aspect-video">
                <div className="text-center px-4">
                  <p className="font-medium">Live preview</p>
                  <p className="text-xs mt-1 text-slate-400">
                    Your broadcast-quality controls slot in here. Open the
                    public view for the full watch experience.
                  </p>
                </div>
              </div>
              <div className="p-4 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium truncate">{liveStream.title}</p>
                  <p className="text-xs text-slate-500 mt-0.5">LIVE</p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Link
                    href={`/stream/${liveStream.id}`}
                    className="btn-secondary !py-1.5 !px-3 text-xs"
                  >
                    Open
                  </Link>
                  <button
                    className="btn-danger !py-1.5 !px-3 text-xs"
                    onClick={() => setStatus(liveStream, "ended")}
                  >
                    End stream
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="card p-5">
              <h2 className="font-semibold mb-1">Go live</h2>
              <p className="text-sm text-slate-500 mb-4">
                You aren&rsquo;t live right now. Create a stream, or flip a
                scheduled one to live.
              </p>
              <button
                className="btn-primary"
                onClick={() => setShowStreamForm((v) => !v)}
              >
                {showStreamForm ? "Cancel" : "+ New stream"}
              </button>
              {showStreamForm ? (
                <form
                  onSubmit={createStream}
                  className="mt-3 space-y-3"
                >
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

              {/* Scheduled streams: list with a quick Go-live button each */}
              <div className="mt-5 space-y-2">
                <h3 className="text-sm font-medium text-slate-600">
                  Scheduled
                </h3>
                {streamList.filter((s) => s.status === "scheduled").length ===
                0 ? (
                  <p className="text-sm text-slate-400">No scheduled streams.</p>
                ) : (
                  streamList
                    .filter((s) => s.status === "scheduled")
                    .map((s) => (
                      <div
                        key={s.id}
                        className="card p-3 flex items-center justify-between"
                      >
                        <div>
                          <p className="font-medium">{s.title}</p>
                          <p className="text-xs text-slate-500">scheduled</p>
                        </div>
                        <button
                          className="btn-primary !py-1.5 !px-3 text-xs"
                          onClick={() => setStatus(s, "live")}
                        >
                          Go live
                        </button>
                      </div>
                    ))
                )}
              </div>
            </div>
          )}
        </section>

        {/* ─── RIGHT: tabbed telemetry / moderation / catalog ─────────────── */}
        <section className="studio-right">
          <div
            role="tablist"
            className="flex gap-1 mb-3 border-b border-slate-200"
          >
            <TabButton
              active={tab === "telemetry"}
              onClick={() => setTab("telemetry")}
            >
              Telemetry
            </TabButton>
            <TabButton
              active={tab === "moderation"}
              onClick={() => setTab("moderation")}
            >
              Moderation
            </TabButton>
            <TabButton
              active={tab === "catalog"}
              onClick={() => setTab("catalog")}
            >
              Catalog
            </TabButton>
          </div>

          {tab === "telemetry" ? (
            focusStream ? (
              <SalesTelemetry streamId={focusStream.id} />
            ) : (
              <EmptyTabHint>
                Create a stream to see live GMV, units, orders, and conversion.
              </EmptyTabHint>
            )
          ) : null}

          {tab === "moderation" ? (
            focusStream && focusStream.status === "live" ? (
              <ChatModeration streamId={focusStream.id} />
            ) : (
              <EmptyTabHint>
                Moderation is meaningful while you&rsquo;re live. Go live to
                see the live chat console.
              </EmptyTabHint>
            )
          ) : null}

          {tab === "catalog" ? (
            <div className="space-y-6">
              <CatalogProducts
                products={productList}
                showForm={showProductForm}
                editing={editing}
                onToggleForm={() => {
                  setEditing(null);
                  setShowProductForm((v) => !v);
                }}
                onEdit={(p) => {
                  setEditing(p);
                  setShowProductForm(true);
                }}
                onDelete={deleteProduct}
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

              <CatalogStreams
                streams={streamList}
                showForm={showStreamForm}
                onToggleForm={() => setShowStreamForm((v) => !v)}
                streamTitle={streamTitle}
                onTitleChange={setStreamTitle}
                onCreate={createStream}
                onSetStatus={setStatus}
                pinningStreamId={pinningStreamId}
                onPin={pinProduct}
                products={productList}
                onSavePromo={savePromo}
              />
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function TabButton({ active, onClick, children }: TabButtonProps) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={
        "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition " +
        (active
          ? "border-primary text-primary"
          : "border-transparent text-slate-500 hover:text-slate-700")
      }
    >
      {children}
    </button>
  );
}

function EmptyTabHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="card p-6 text-center text-sm text-slate-500">
      {children}
    </div>
  );
}

interface CatalogProductsProps {
  products: Product[];
  showForm: boolean;
  editing: Product | null;
  onToggleForm: () => void;
  onEdit: (p: Product) => void;
  onDelete: (id: string) => void;
  onSaved: () => void;
  onCancel: () => void;
}

function CatalogProducts({
  products,
  showForm,
  editing,
  onToggleForm,
  onEdit,
  onDelete,
  onSaved,
  onCancel,
}: CatalogProductsProps) {
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold">Products ({products.length})</h2>
        <button className="btn-secondary !py-1.5" onClick={onToggleForm}>
          {showForm ? "Cancel" : "+ Add product"}
        </button>
      </div>

      {showForm ? (
        <div className="card p-4 mb-3">
          <ProductForm
            product={editing}
            onSaved={onSaved}
            onCancel={onCancel}
          />
        </div>
      ) : null}

      <div className="space-y-2">
        {products.length === 0 ? (
          <p className="text-sm text-slate-400">No products yet.</p>
        ) : (
          products.map((p) => (
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
                className="text-xs text-primary-dark hover:underline"
                onClick={() => onEdit(p)}
              >
                Edit
              </button>
              <button
                className="text-xs text-rose-600 hover:underline"
                onClick={() => onDelete(p.id)}
              >
                Delete
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

interface CatalogStreamsProps {
  streams: Stream[];
  showForm: boolean;
  onToggleForm: () => void;
  streamTitle: string;
  onTitleChange: (v: string) => void;
  onCreate: (e: React.FormEvent) => void;
  onSetStatus: (stream: Stream, status: Stream["status"]) => void;
  pinningStreamId: string | null;
  onPin: (stream: Stream, productId: string | null) => void;
  products: Product[];
  onSavePromo: (stream: Stream, text: string, link: string) => Promise<void>;
}

function CatalogStreams({
  streams,
  showForm,
  onToggleForm,
  streamTitle,
  onTitleChange,
  onCreate,
  onSetStatus,
  pinningStreamId,
  onPin,
  products,
  onSavePromo,
}: CatalogStreamsProps) {
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold">Streams ({streams.length})</h2>
        <button className="btn-secondary !py-1.5" onClick={onToggleForm}>
          {showForm ? "Cancel" : "+ New stream"}
        </button>
      </div>

      {showForm ? (
        <form onSubmit={onCreate} className="card p-4 mb-3 space-y-3">
          <input
            className="input"
            placeholder="Stream title"
            value={streamTitle}
            onChange={(e) => onTitleChange(e.target.value)}
            required
            maxLength={120}
          />
          <button type="submit" className="btn-primary">
            Create stream
          </button>
        </form>
      ) : null}

      <div className="space-y-3">
        {streams.length === 0 ? (
          <p className="text-sm text-slate-400">No streams yet.</p>
        ) : (
          streams.map((s) => (
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
                    Status: <span className="font-medium">{s.status}</span>
                  </p>
                </div>
                <div className="flex gap-1">
                  {s.status === "scheduled" ? (
                    <button
                      className="btn-primary !py-1.5 !px-3 text-xs"
                      onClick={() => onSetStatus(s, "live")}
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
                        onClick={() => onSetStatus(s, "ended")}
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
                    onChange={(e) => onPin(s, e.target.value || null)}
                  >
                    <option value="">— None —</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({formatNpr(p.price_cents)})
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] text-slate-400 mt-1">
                    Changing this updates the pinned card for all viewers in
                    real time.
                  </p>

                  {/* Promo banner — only shown while live. Self-contained
                      form that initializes from the stream row and saves
                      via /api/streams/[id]/promo. */}
                  <PromoEditor stream={s} onSave={onSavePromo} />
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Self-contained promo-banner editor for a live stream. Initializes its inputs
 * from the stream row and re-syncs if the row changes from elsewhere (e.g. a
 * realtime update), but otherwise lets the seller type freely and save on
 * submit. Empty fields clear the banner (server normalizes "" → null).
 */
function PromoEditor({
  stream,
  onSave,
}: {
  stream: Stream;
  onSave: (stream: Stream, text: string, link: string) => Promise<void>;
}) {
  const [text, setText] = useState(stream.promo_banner_text ?? "");
  const [link, setLink] = useState(stream.promo_banner_link ?? "");
  const [saving, setSaving] = useState(false);

  // Re-sync when the underlying stream row changes (external update). Lives in
  // an effect (not render) because the sync must fire only when the parent
  // actually surfaces a NEW row value -- a render-path derivation would run on
  // every render and clobber a buyer's in-progress edits to the text/link.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- echoes an externally-
     * mutated prop back into local editable state; the in-flight-edit guard is
     * exactly why this can't be derived during render. */
    setText(stream.promo_banner_text ?? "");
    setLink(stream.promo_banner_link ?? "");
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [stream.promo_banner_text, stream.promo_banner_link]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    await onSave(stream, text, link);
    setSaving(false);
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-2">
      <label className="block text-xs font-medium text-slate-600">
        Promo banner text
      </label>
      <input
        className="input"
        placeholder="e.g. Free shipping for the next 5 buyers!"
        value={text}
        maxLength={140}
        onChange={(e) => setText(e.target.value)}
      />
      <label className="block text-xs font-medium text-slate-600">
        Promo link (optional — opens in a new tab)
      </label>
      <input
        className="input"
        type="url"
        placeholder="https://…"
        value={link}
        onChange={(e) => setLink(e.target.value)}
      />
      <button
        type="submit"
        className="btn-secondary !py-1.5 text-xs"
        disabled={saving}
      >
        {saving ? "Saving…" : "Save promo banner"}
      </button>
    </form>
  );
}
