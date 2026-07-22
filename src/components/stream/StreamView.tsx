"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import StreamRoom from "@/components/StreamRoom";
import TopBar, { type PresenceViewer } from "@/components/stream/TopBar";
import BulletComments from "@/components/stream/BulletComments";
import ChatLog from "@/components/stream/ChatLog";
import ProductCard from "@/components/stream/ProductCard";
import CheckoutSheet from "@/components/stream/CheckoutSheet";
import ReactionRail from "@/components/stream/ReactionRail";
import PurchaseTicker from "@/components/stream/PurchaseTicker";
import RankBadge from "@/components/stream/RankBadge";
import PromoBanner from "@/components/stream/PromoBanner";
import BottomActionBar from "@/components/stream/BottomActionBar";
import StreamEndedCard from "@/components/stream/StreamEndedCard";
import ConnectionOverlay, {
  type ConnectionState,
} from "@/components/stream/ConnectionOverlay";
import { ModerationProvider, useModeration } from "@/components/stream/ModerationMenu";
import type { StreamConnState } from "@/components/StreamRoom";
import {
  AuthInterceptorProvider,
  consumeStashedIntent,
} from "@/components/auth/AuthInterceptorProvider";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { removeChannelSilently } from "@/lib/realtime-cleanup";
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
  /**
   * Called when this stream ends while the viewer is watching (status flips
   * away from `live`). In the feed this advances to the next live stream; on
   * the detail page it's omitted and the StreamEndedCard shows a back link.
   */
  onEndedAdvance?: () => void;
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
  onEndedAdvance,
}: StreamViewProps) {
  const supabase = createSupabaseBrowserClient();
  const isActive = active ?? true;
  // Feed mode: fill the parent slide. Detail page (active undefined): phone frame.
  const inFeed = active !== undefined;
  // Whether this stream has ended while the viewer was watching it (plan §9.A).
  // Driven by the streams-row subscription below; resets on stream change.
  const [ended, setEnded] = useState<Stream["status"] | null>(
    stream.status === "live" ? null : stream.status,
  );
  // §9.A — aggregated connection state surfaced by StreamRoom's token-fetch +
  // LiveKit lifecycle. Drives the ConnectionOverlay over the cinema canvas.
  const [connState, setConnState] = useState<ConnectionState>("connecting");
  // Bumped to force StreamRoom out of a Failed state and retry the token fetch.
  const [retryToken, setRetryToken] = useState(0);

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

  // ── Moderation (P2-E): the viewer's block list, loaded on activation. ──
  // Filters both the bullet layer and the chat log so blocked/muted users'
  // messages never render for the blocker. Anon viewers have no block list.
  const [blockedIds, setBlockedIds] = useState<Set<string>>(new Set());

  // -- P4-A/D: seller-side stream mutes drive an ALL-VIEWERS filter. --
  // Unlike the personal block list (applies only to the blocker), the
  // seller muting a user hides that user's future messages for EVERY
  // viewer of the stream -- the filter lives here, fed by a realtime
  // subscription on `stream_mutes`. Both filters apply in combination
  // (hidden if EITHER the blocker blocked the author OR the seller
  // muted them).
  const [sellerMutedIds, setSellerMutedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!isActive || !viewerId) {
      /* eslint-disable react-hooks/set-state-in-effect -- deactivation guard:
       * drops the block list so a re-activation can't leak a previous viewer's
       * blocks. The async fetch below also writes setBlockedIds, so this is the
       * legitimate "subscribe + tear down" effect shape, not pure derivation. */
      setBlockedIds(new Set());
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/block", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { blockedIds: string[] };
        if (cancelled) return;
        setBlockedIds(new Set(data.blockedIds ?? []));
      } catch {
        // best-effort; the viewer just sees an unfiltered chat.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isActive, viewerId]);

  // -- P4-D: subscribe to the seller's stream_mutes for THIS stream. --
  // On activation, load the current mute list, then watch INSERT/DELETE so
  // the seller muting someone mid-stream propagates to every viewer's
  // filter in real time (the table is in supabase_realtime; see
  // 0010_stream_mutes_bans.sql). Anon viewers also need this -- seller
  // mutes apply to everyone, regardless of auth.
  useEffect(() => {
    if (!isActive) {
      /* eslint-disable react-hooks/set-state-in-effect -- teardown guard: drops
       * the seller mutes so a re-activation can't leak a previous stream's
       * mutes. The async subscription below also writes this state, so this is
       * the legitimate "subscribe + tear down" effect shape, not pure
       * derivation. */
      setSellerMutedIds(new Set());
      return;
    }
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("stream_mutes")
        .select("user_id")
        .eq("stream_id", stream.id);
      if (cancelled) return;
      setSellerMutedIds(
        new Set(
          ((data as { user_id: string }[] | null) ?? []).map(
            (r) => r.user_id,
          ),
        ),
      );

      channel = supabase
        .channel(`stream-mutes:${stream.id}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "stream_mutes",
            filter: `stream_id=eq.${stream.id}`,
          },
          (payload) => {
            const row = payload.new as { user_id: string };
            setSellerMutedIds((prev) => new Set(prev).add(row.user_id));
          },
        )
        .on(
          "postgres_changes",
          {
            event: "DELETE",
            schema: "public",
            table: "stream_mutes",
            filter: `stream_id=eq.${stream.id}`,
          },
          (payload) => {
            const row = payload.old as { user_id: string };
            setSellerMutedIds((prev) => {
              const next = new Set(prev);
              next.delete(row.user_id);
              return next;
            });
          },
        )
        .subscribe();
    })();

    return () => {
      cancelled = true;
      void removeChannelSilently(supabase, channel);
    };
  }, [supabase, stream.id, isActive]);

  // Apply BOTH chat-hiding filters to the messages feeding the bullet window
  // AND the chat log:
  //   1. blockedIds      -- the viewer's OWN block list (P2-E; this viewer only)
  //   2. sellerMutedIds  -- the SELLER's stream mutes (P4-A; ALL viewers)
  // A message is hidden if EITHER filter matches its author. Anon viewers have
  // no personal block list (blockedIds stays empty) but seller mutes STILL
  // apply -- that's the whole point of seller-side moderation.
  //
  // The session-local mute set from ModerationProvider is separately applied
  // in the render path (FilteredChatLog wrapper); the two client-side filters
  // (block + session mute) stack on top of these two here.
  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (m) =>
          !blockedIds.has(m.user_id) && !sellerMutedIds.has(m.user_id),
      ),
    [messages, blockedIds, sellerMutedIds],
  );

  // Newest-first window for the bullet overlay (FIFO cap lives in BulletComments).
  const bulletWindow = useMemo(
    () => [...visibleMessages].reverse(),
    [visibleMessages],
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
        .is("deleted_at", null)  // P4-D: drop seller-soft-deleted rows
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
            // P4-D: defensively drop softly-deleted rows (the initial
            // load filters them; an INSERT carrying a non-null
            // deleted_at shouldn't happen but we tolerate it).
            if (newRow.deleted_at != null) return;
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
        // P4-D: when the seller soft-deletes a message, the UPDATE
        // arrives through this same channel. Drop the row from our
        // local list so it disappears from the bullet layer + chat log
        // for every viewer in real time.
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "chat_messages",
            filter: `stream_id=eq.${stream.id}`,
          },
          (payload) => {
            const row = payload.new as ChatMessageWithUser;
            if (!row.deleted_at) return;
            setMessages((prev) => prev.filter((m) => m.id !== row.id));
          },
        )
        .subscribe();
    })();

    return () => {
      cancelled = true;
      void removeChannelSilently(supabase, channel);
    };
  }, [supabase, stream.id, isActive]);

  // ── Pinned product: watch the stream row for pin/unpin changes (same ──
  // subscription pattern as the legacy PinnedProduct component). Tapping the
  // card opens the CheckoutSheet; the checkout logic itself is untouched.
  const [pinnedId, setPinnedId] = useState<string | null>(
    stream.pinned_product_id,
  );
  const [pinnedProduct, setPinnedProduct] = useState<Product | null>(
    initialPinnedProduct,
  );
  // If the pin is cleared, drop the cached product. "Adjust state during
  // render" (react.dev/reference/react/useState#storing-information-from-
  // previous-renders): cheaper than a commit-phase effect and lands before
  // `pinnedProduct` is read in the JSX below.
  if (!pinnedId && pinnedProduct !== null) {
    setPinnedProduct(null);
  }
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
          // §9.A: detect the stream ending while the viewer watches. Once it
          // flips away from `live`, show the ended card instead of a frozen
          // feed. (A later re-broadcast would re-live the stream; until then
          // the card stays.)
          if (updated.status !== "live") setEnded(updated.status);
        },
      )
      .subscribe();
    return () => {
      void removeChannelSilently(supabase, channel);
    };
  }, [supabase, stream.id, isActive]);

  // When the pinned id changes, fetch the product details. The null-clear case
  // is handled in render above; this effect only fires the fetch.
  useEffect(() => {
    if (!pinnedId) return;
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
      void removeChannelSilently(supabase, channel);
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

  // ── P2-D: intent replay ──────────────────────────────────────────────────
  // After a guest signs in via the auth half-sheet, OAuth/magic-link returns the
  // browser to this stream (via /auth/callback?next=/stream/<id>). On mount, if
  // there's a stashed intent AND the viewer is now authed AND the intent belongs
  // to this stream, replay the action they were trying to perform. Stale or
  // mismatched intents are dropped silently (the intent is already consumed by
  // `consumeStashedIntent`, so it can't re-fire on a later visit).
  useEffect(() => {
    if (!isActive) return; // never replay on an inactive feed slide
    const intent = consumeStashedIntent();
    if (!intent || intent.streamId !== stream.id) return;
    // Only replay if the viewer is now actually signed in. An anon viewer landing
    // here with a stale intent (e.g. they didn't complete sign-in) gets nothing.
    if (!viewerId) return;

    // Defer state updates off the effect body so we don't trigger a synchronous
    // re-render during the commit phase (react-hooks/set-state-in-effect). The
    // microtask runs after the current paint, before the next render — fast
    // enough that the replay still feels instant, but non-cascading.
    switch (intent.kind) {
      case "buy":
        // Re-open the checkout sheet on the same product, if it's still pinned.
        if (pinnedProduct?.id === intent.productId) {
          queueMicrotask(() => setIsCheckoutOpen(true));
        }
        break;
      case "follow":
        // Fire the follow directly — idempotent (duplicate = 200 alreadyFollowing).
        // We don't touch FollowButton's local state; the next page load resolves
        // initiallyFollowing server-side, so the button reflects the new edge.
        void fetch("/api/follow", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ followeeId: seller?.id ?? "" }),
        }).catch(() => {
          // best-effort; the follow can be re-tapped manually.
        });
        break;
      case "chat":
        // Open the chat-log overlay so the viewer lands where they can type.
        queueMicrotask(() => setChatLogOpen(true));
        break;
      case "gift":
        void triggerGift();
        break;
    }
    // Run once per stream mount; deps are intentionally the identities involved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      void removeChannelSilently(supabase, channel);
    };
  }, [supabase, stream.id, viewerId, viewerName, isActive]);

  // ── Reset ephemeral state when the stream deactivates so stale bullet ──
  // comments, reactions, and viewer counts never bleed into a re-activation.
  // This is pure teardown — it runs exactly when `isActive` flips false and
  // clears every realtime-mirrored slice so a re-activation starts clean. It
  // can't be a derived value (the writes above this effect ARE the source of
  // truth during active periods), so the effect body is the right place.
  useEffect(() => {
    if (isActive) return;
    /* eslint-disable react-hooks/set-state-in-effect -- deactivation teardown */
    setMessages([]);
    setReactionTotals({ heart: 0, gift: 0 });
    setViewerCount(0);
    setRecentViewers([]);
    setSellerMutedIds(new Set());
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [isActive]);

  return (
    <AuthInterceptorProvider
      viewerId={viewerId}
      redirectTo={`/stream/${stream.id}`}
    >
      <ModerationProvider streamId={stream.id} initialBlockedIds={blockedIds}>
        <div
        className={
          inFeed
            ? "relative h-full w-full overflow-hidden bg-cinema"
            : "relative mx-auto h-[100dvh] w-full overflow-hidden bg-cinema md:h-[760px] md:max-w-[420px]"
        }
      >
        {/* ── Base layer: the LiveKit video/participant view (z-video) ── */}
        <div className="absolute inset-0 z-video">
        <StreamRoom
          stream={stream}
          role={role}
          viewerId={viewerId}
          viewerName={viewerName}
          active={isActive}
          onConnectionStateChange={(s: StreamConnState) => setConnState(s)}
          retryToken={retryToken}
        />
      </div>

      {/* ── §9.A: connection-state overlay (connecting / reconnecting / ──
          buffering / failed). Rendered above the video base so a transient
          network blip or a dropped LiveKit connection never shows as a silent
          black screen. The "failed" Retry button bumps retryToken, which
          StreamRoom watches to restart the token-fetch sequence. */}
      {connState !== "connected" ? (
        <ConnectionOverlay
          state={connState}
          onRetry={() => setRetryToken((n) => n + 1)}
        />
      ) : null}

      {/* ── §9.A: "stream ended" card. Renders when the live row flipped away ──
          from `live` while the viewer was watching. In the feed it auto-advances
          via onEndedAdvance; on the detail page it offers a back-to-feed link. */}
      {ended ? (
        <StreamEndedCard
          seller={seller}
          viewerId={viewerId}
          onNext={onEndedAdvance}
          detailMode={!inFeed}
        />
      ) : null}

      {/* ── TopBar (step 3) ── */}
      <TopBar
        seller={seller}
        verified={Boolean(seller?.is_verified)}
        viewerCount={viewerCount}
        recentViewers={recentViewers}
        viewerId={viewerId}
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
          conversation reader. Toggled from BottomActionBar's message icon. The
          ChatLog component owns its own scroll-to-bottom + mute filtering
          (P2-E) and is long-pressable to open the ModerationMenu. */}
      {chatLogOpen ? (
        <ChatLog
          messages={visibleMessages}
          onClose={() => setChatLogOpen(false)}
        />
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
            seller={seller}
          />
        </div>
      </ModerationProvider>
    </AuthInterceptorProvider>
  );
}
