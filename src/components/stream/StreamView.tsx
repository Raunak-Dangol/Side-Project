"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import StreamRoom from "@/components/StreamRoom";
import TopBar, { type PresenceViewer } from "@/components/stream/TopBar";
import BulletComments from "@/components/stream/BulletComments";
import ProductCard from "@/components/stream/ProductCard";
import CheckoutSheet from "@/components/stream/CheckoutSheet";
import ReactionRail from "@/components/stream/ReactionRail";
import PurchaseTicker from "@/components/stream/PurchaseTicker";
import RankBadge from "@/components/stream/RankBadge";
import PromoBanner from "@/components/stream/PromoBanner";
import BottomActionBar from "@/components/stream/BottomActionBar";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { escapeForRender } from "@/lib/sanitize";
import { timeAgo } from "@/lib/utils";
import type { StreamFeedSeller, Product, Stream, ChatMessageWithUser } from "@/lib/types";

interface StreamViewProps {
  stream: Stream;
  seller: StreamFeedSeller | null;
  initialPinnedProduct: Product | null;
  role: "seller" | "viewer";
  viewerId: string | null;
  viewerName?: string;
  /**
   * When false (feed context), every resource-allocating effect bails out and
   * cleans up: no LiveKit connection, no Supabase Realtime channels, no
   * presence, no polling/timers. Defaults to true so the `/stream/[id]` detail
   * page is unaffected.
   */
  active?: boolean;
}

/**
 * Full-screen, mobile-first Douyin/TikTok-style layout shell.
 *
 * The container is the only thing sized to the viewport: `100dvh` on mobile
 * (dvh, not vh — avoids the mobile-browser address-bar resize jump), capped to a
 * fixed phone-frame height + 420px width on `md`+ and centered. Every overlay
 * element is `position: absolute` over the video base layer — NEVER `fixed`,
 * which interacts badly with mobile address-bar show/hide.
 *
 * Owns all realtime state (presence viewer count, chat, pinned product,
 * reactions, rank) and passes props down to presentational children.
 */
export default function StreamView({
  stream,
  seller,
  initialPinnedProduct,
  role,
  viewerId,
  viewerName,
  active,
}: StreamViewProps) {
  const supabase = createSupabaseBrowserClient();
  const isActive = active ?? true;
  // Feed mode: fill the parent slide. Detail page (active undefined): phone frame.
  const inFeed = active !== undefined;

  // ── Presence: single source of truth for viewer count + recent-joiner stack ──
  // One channel for the whole stream; every client tracks itself and reacts to
  // join/leave/sync events. The "recent viewers" list is the last few distinct
  // joiners (newest first) for the avatar stack in TopBar.
  const [viewerCount, setViewerCount] = useState(0);
  const [recentViewers, setRecentViewers] = useState<PresenceViewer[]>([]);

  // ── Chat: one realtime subscription feeds both the ambient bullets and the ──
  // full chat-log overlay. Same initial-load + INSERT pattern as the legacy
  // ChatPanel, kept here so all realtime wiring lives in one place.
  const [messages, setMessages] = useState<ChatMessageWithUser[]>([]);
  const [chatLogOpen, setChatLogOpen] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  // Newest-first window for the bullet overlay (FIFO cap lives in BulletComments).
  const bulletWindow = useMemo(
    () => [...messages].reverse(),
    [messages],
  );

  useEffect(() => {
    if (!isActive) return; // feed: no realtime channels for inactive streams
    let channel: ReturnType<typeof supabase.channel> | null = null;
    // Same StrictMode race guard as the presence effect above.
    let cancelled = false;

    (async () => {
      const { data } = await supabase
        .from("chat_messages")
        .select("*, profiles:profiles!user_id(id, display_name)")
        .eq("stream_id", stream.id)
        .order("created_at", { ascending: true })
        .limit(100);
      if (cancelled) return; // effect torn down during the await
      if (data) setMessages(data as ChatMessageWithUser[]);

      channel = supabase
        .channel(`chat:${stream.id}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "chat_messages",
            filter: `stream_id=eq.${stream.id}`,
          },
          async (payload) => {
            const newRow = payload.new as ChatMessageWithUser;
            const { data: profileRow } = await supabase
              .from("profiles")
              .select("id, display_name")
              .eq("id", newRow.user_id)
              .single();
            setMessages((prev) => [
              ...prev,
              { ...newRow, profiles: profileRow ?? null },
            ]);
          },
        )
        .subscribe();
    })();

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [supabase, stream.id, isActive]);

  // Keep the full chat log scrolled to the latest while open.
  useEffect(() => {
    if (!chatLogOpen) return;
    chatScrollRef.current?.scrollTo({
      top: chatScrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, chatLogOpen]);

  // ── Pinned product: watch the stream row for pin/unpin changes (same ──
  // subscription pattern as the legacy PinnedProduct component). Tapping the
  // card opens the CheckoutSheet; the checkout logic itself is untouched.
  const [pinnedId, setPinnedId] = useState<string | null>(
    stream.pinned_product_id,
  );
  const [pinnedProduct, setPinnedProduct] = useState<Product | null>(
    initialPinnedProduct,
  );
  const [isCheckoutOpen, setIsCheckoutOpen] = useState(false);
  // Promo banner fields — kept fresh by the same streams-row subscription below.
  const [promoText, setPromoText] = useState<string | null>(
    stream.promo_banner_text,
  );
  const [promoLink, setPromoLink] = useState<string | null>(
    stream.promo_banner_link,
  );

  useEffect(() => {
    if (!isActive) return; // feed: no realtime channels for inactive streams
    const channel = supabase
      .channel(`stream-pinned:${stream.id}`)
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
          setPromoText(updated.promo_banner_text);
          setPromoLink(updated.promo_banner_link);
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, stream.id, isActive]);

  // When the pinned id changes, fetch the product details.
  useEffect(() => {
    if (!pinnedId) {
      setPinnedProduct(null);
      return;
    }
    if (pinnedProduct?.id === pinnedId) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("products")
        .select("*")
        .eq("id", pinnedId)
        .single();
      if (!cancelled) setPinnedProduct((data as Product | null) ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [pinnedId, pinnedProduct?.id, supabase]);

  // ── Reactions: subscribe to reaction-total updates so every viewer sees the ─
  // same live counter, not just the tapper. Initial load + UPDATE on the
  // `reactions` rows for this stream.
  const [reactionTotals, setReactionTotals] = useState<{
    heart: number;
    gift: number;
  }>({ heart: 0, gift: 0 });

  useEffect(() => {
    if (!isActive) return; // feed: no realtime channels for inactive streams
    let channel: ReturnType<typeof supabase.channel> | null = null;
    // Same StrictMode race guard as the presence effect above.
    let cancelled = false;

    (async () => {
      const { data } = await supabase
        .from("reactions")
        .select("kind, count")
        .eq("stream_id", stream.id);
      const totals = { heart: 0, gift: 0 };
      for (const r of (data ?? []) as Array<{ kind: string; count: number }>) {
        if (r.kind === "heart") totals.heart = r.count;
        else if (r.kind === "gift") totals.gift = r.count;
      }
      setReactionTotals(totals);

      if (cancelled) return; // effect torn down during the await

      channel = supabase
        .channel(`reactions:${stream.id}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "reactions",
            filter: `stream_id=eq.${stream.id}`,
          },
          (payload) => {
            const row = (payload.new ?? null) as
              | { kind: string; count: number }
              | null;
            if (!row) return;
            setReactionTotals((prev) =>
              row.kind === "heart"
                ? { ...prev, heart: row.count }
                : row.kind === "gift"
                  ? { ...prev, gift: row.count }
                  : prev,
            );
          },
        )
        .subscribe();
    })();

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [supabase, stream.id, isActive]);

  // Gift sent from the BottomActionBar gift icon — a discrete single reaction
  // posted immediately (no batching, unlike the rapid-tap rail).
  const triggerGift = useCallback(async () => {
    try {
      await fetch(`/api/streams/${stream.id}/react`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "gift", amount: 1 }),
      });
    } catch {
      // Best-effort; the live total still syncs via realtime for everyone.
    }
  }, [stream.id]);

  useEffect(() => {
    if (!isActive) return; // feed: never track presence for inactive streams
    // Stable identity per tab. Authenticated viewers use their user id; anon
    // viewers get a synthetic id so they still count toward the total.
    const myId = viewerId ?? `anon-${Math.random().toString(36).slice(2, 10)}`;

    let channel: ReturnType<typeof supabase.channel> | null = null;
    // Guard the async gap: in React StrictMode (dev) the effect is torn down
    // and re-run immediately. The profile fetch below `await`s, so without a
    // guard the first run resolves *after* the second has already created and
    // subscribed the channel — `channel(name)` then returns that same cached
    // instance and the first run throws "cannot add presence callbacks after
    // subscribe()". `cancelled` lets the stale run bail out after its await.
    let cancelled = false;

    (async () => {
      // Resolve the viewer's display name for the avatar stack (best-effort —
      // anon viewers just show "?").
      let myName: string | null = viewerName ?? null;
      if (viewerId) {
        const { data: me } = await supabase
          .from("profiles")
          .select("display_name")
          .eq("id", viewerId)
          .maybeSingle();
        if (cancelled) return; // effect torn down during the await
        myName = me?.display_name ?? myName;
      }

      const presenceState = {
        id: myId,
        display_name: myName,
        joined_at: Date.now(),
      };

      channel = supabase.channel(`stream:viewers:${stream.id}`, {
        config: { presence: { key: myId } },
      });

      const recompute = (state: Record<string, Array<typeof presenceState>>) => {
        const all = Object.values(state).flat();
        setViewerCount(all.length);
        // Newest joiners first, distinct by id.
        const sorted = [...all].sort((a, b) => b.joined_at - a.joined_at);
        const seen = new Set<string>();
        const distinct: PresenceViewer[] = [];
        for (const v of sorted) {
          if (seen.has(v.id)) continue;
          seen.add(v.id);
          distinct.push({ id: v.id, display_name: v.display_name });
          if (distinct.length >= 3) break;
        }
        setRecentViewers(distinct);
      };

      channel
        .on("presence", { event: "sync" }, () => {
          recompute(channel!.presenceState() as Record<string, Array<typeof presenceState>>);
        })
        .on("presence", { event: "join" }, ({ key, newPresences }) => {
          // A new distinct joiner goes to the front of the avatar stack.
          const fresh = newPresences[0];
          if (!fresh) return;
          setRecentViewers((prev) => {
            const without = prev.filter((v) => v.id !== key);
            return [{ id: key, display_name: fresh.display_name ?? null }, ...without].slice(0, 3);
          });
        })
        .subscribe(async (status) => {
          if (status === "SUBSCRIBED") {
            await channel!.track(presenceState);
          }
        });
    })();

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [supabase, stream.id, viewerId, viewerName, isActive]);

  // ── Reset ephemeral state when the stream deactivates so stale bullet ──
  // comments, reactions, and viewer counts never bleed into a re-activation.
  useEffect(() => {
    if (isActive) return;
    setMessages([]);
    setReactionTotals({ heart: 0, gift: 0 });
    setViewerCount(0);
    setRecentViewers([]);
  }, [isActive]);

  return (
    <div
      className={
        inFeed
          ? "relative h-full w-full overflow-hidden bg-black"
          : "relative mx-auto h-[100dvh] w-full overflow-hidden bg-black md:h-[760px] md:max-w-[420px]"
      }
    >
      {/* ── Base layer: the LiveKit video/participant view (z-0) ── */}
      <div className="absolute inset-0 z-0">
        <StreamRoom
          stream={stream}
          role={role}
          viewerId={viewerId}
          viewerName={viewerName}
          active={isActive}
        />
      </div>

      {/* ── TopBar (step 3) ── */}
      <TopBar
        seller={seller}
        verified={Boolean(seller?.is_verified)}
        viewerCount={viewerCount}
        recentViewers={recentViewers}
      />

      {/* ── RankBadge (step 8): hourly rank pill, fed by presence count ── */}
      <RankBadge streamId={stream.id} viewerCount={viewerCount} />

      {/* ── ReactionRail (step 6): heart/gift taps + live totals ── */}
      <ReactionRail streamId={stream.id} totals={reactionTotals} />

      {/* ── PurchaseTicker (step 7): rolling "added to cart" pill ── */}
      <PurchaseTicker streamId={stream.id} />

      {/* ── BulletComments (step 4): ambient fading pills ── */}
      <BulletComments messages={bulletWindow} />

      {/* ── Full chat log overlay (step 4): reachable ambient→history view ──
          The bullet view is atmosphere only; this scrollable list is the real
          conversation reader. Toggled from BottomActionBar's message icon. */}
      {chatLogOpen ? (
        <div className="absolute inset-x-0 bottom-0 z-40 flex h-[55%] flex-col rounded-t-xl bg-black/80 backdrop-blur-md">
          <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
            <span className="text-xs font-medium text-white">Live chat</span>
            <button
              type="button"
              onClick={() => setChatLogOpen(false)}
              aria-label="Close chat"
              className="text-white/70 transition hover:text-white"
            >
              ✕
            </button>
          </div>
          <div
            ref={chatScrollRef}
            className="flex-1 space-y-1.5 overflow-y-auto p-3 text-sm"
          >
            {messages.length === 0 ? (
              <p className="text-xs text-white/50">No messages yet. Say hi 👋</p>
            ) : (
              messages.map((m) => (
                <div key={m.id} className="leading-snug">
                  <span className="font-medium text-sky-300">
                    {m.profiles?.display_name ?? "Someone"}
                  </span>{" "}
                  <span className="text-[10px] text-white/40">
                    {timeAgo(m.created_at)}
                  </span>
                  <div className="text-white/90">{escapeForRender(m.message)}</div>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}

      {/* ── ProductCard + CheckoutSheet (step 5) ──
          Card hidden entirely when nothing is pinned. Tapping it (or its buy
          button) opens the sheet, whose checkout logic is the verbatim
          startCheckout from the legacy BuyModal — money flow untouched. */}
      {pinnedProduct ? (
        <>
          <ProductCard
            product={pinnedProduct}
            onBuy={() => setIsCheckoutOpen(true)}
          />
          <CheckoutSheet
            open={isCheckoutOpen}
            onClose={() => setIsCheckoutOpen(false)}
            product={pinnedProduct}
            streamId={stream.id}
          />
        </>
      ) : null}

      {/* ── PromoBanner (step 9): strip above BottomActionBar, live-synced ── */}
      <PromoBanner text={promoText} link={promoLink} />

      {/* ── BottomActionBar (step 10): chat input + gift/message/more ── */}
      <BottomActionBar
        streamId={stream.id}
        onOpenChat={() => setChatLogOpen(true)}
        onSendGift={triggerGift}
      />
    </div>
  );
}
