"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { removeChannelSilently } from "@/lib/realtime-cleanup";
import { timeAgo } from "@/lib/utils";
import type { ChatMessageWithUser } from "@/lib/types";

interface Props {
  streamId: string;
}

/**
 * Seller-side chat moderation console (Phase 4 / P4-C).
 *
 * Renders a live chat feed for the seller's active stream — UNFILTERED, so
 * the seller sees everything including muted users&#39; attempts (they need to
 * see what's being posted to decide whether to ban). Each message row has
 * three actions:
 *
 *   • Mute user   — POST/DELETE /api/seller/moderation (insert/delete stream_mutes)
 *   • Ban user    — POST /api/seller/moderation/ban   (insert stream_bans + LiveKit kick)
 *   • Delete msg  — POST /api/seller/moderation/message (soft-delete chat_messages.deleted_at)
 *
 * The mute list is kept live so the button per message reflects current
 * state: subscribing to `stream_mutes` INSERT/DELETE keeps `mutedIds` fresh
 * even if the seller mutes/unmutes from another tab. Ban is one-shot (a
 * banned user can't post again — they're kicked — so we don't track live
 * ban state per message; the action is always available if not banned, and
 * idempotent on the server regardless).
 *
 * Deleted messages stay in this feed (with a "Removed" tag) so the seller
 * sees the audit trail; viewers see them drop out via the StreamView filter.
 */
export default function ChatModeration({ streamId }: Props) {
  const supabase = createSupabaseBrowserClient();
  const [messages, setMessages] = useState<ChatMessageWithUser[]>([]);
  const [mutedIds, setMutedIds] = useState<Set<string>>(new Set());
  const [bannedIds, setBannedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  // Pending ban confirmation modal — keyed by messageId+userId.
  const [confirmingBan, setConfirmingBan] = useState<{
    userId: string;
    displayName: string;
  } | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);

  // ── initial messages + INSERT subscription ──────────────────────────────
  // UNFILTERED: the seller's console deliberately does not apply the mute /
  // deleted_at filter — the seller needs to see what was said to moderate it.
  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;

    (async () => {
      const { data } = await supabase
        .from("chat_messages")
        .select("*, profiles:profiles!user_id(id, display_name)")
        .eq("stream_id", streamId)
        .order("created_at", { ascending: true })
        .limit(200);
      if (cancelled) return;
      setMessages((data as ChatMessageWithUser[] | null) ?? []);

      channel = supabase
        .channel(`seller-chat:${streamId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "chat_messages",
            filter: `stream_id=eq.${streamId}`,
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
        // Soft-delete propagation: when the seller (or, in a multi-tab edge
        // case, themselves elsewhere) sets deleted_at, mark the row in our
        // local feed so it shows the "Removed" tag. We don't drop it from
        // this console — the seller sees the audit trail.
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "chat_messages",
            filter: `stream_id=eq.${streamId}`,
          },
          (payload) => {
            const row = payload.new as ChatMessageWithUser;
            if (!row.deleted_at) return;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === row.id ? { ...m, deleted_at: row.deleted_at } : m,
              ),
            );
          },
        )
        .subscribe();
    })();

    return () => {
      cancelled = true;
      void removeChannelSilently(supabase, channel);
    };
  }, [supabase, streamId]);

  // ── mute list: initial + realtime ─────────────────────────────────────────
  // The mute button per message reflects whether the user is currently muted.
  // Subscribing to stream_mutes INSERT/DELETE keeps this fresh if the seller
  // mods from another tab (orbits the local UI's optimistic update).
  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;

    (async () => {
      const { data } = await supabase
        .from("stream_mutes")
        .select("user_id")
        .eq("stream_id", streamId);
      if (cancelled) return;
      setMutedIds(
        new Set(
          ((data as { user_id: string }[] | null) ?? []).map(
            (r) => r.user_id,
          ),
        ),
      );

      channel = supabase
        .channel(`seller-mutes:${streamId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "stream_mutes",
            filter: `stream_id=eq.${streamId}`,
          },
          (payload) => {
            const row = payload.new as { user_id: string };
            setMutedIds((prev) => new Set(prev).add(row.user_id));
          },
        )
        .on(
          "postgres_changes",
          {
            event: "DELETE",
            schema: "public",
            table: "stream_mutes",
            filter: `stream_id=eq.${streamId}`,
          },
          (payload) => {
            const row = payload.old as { user_id: string };
            setMutedIds((prev) => {
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
  }, [supabase, streamId]);

  // Auto-stick to the bottom of the feed when new messages land (only if the
  // seller is already near the bottom — never yank them up while scrolling
  // back through history to moderate something).
  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    // If the feed is within ~120px of the bottom, snap to it.
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length]);

  async function toggleMute(userId: string) {
    setPendingAction(`${mutedIds.has(userId) ? "unmute" : "mute"}:${userId}`);
    setError(null);
    try {
      const res = await fetch(
        mutedIds.has(userId)
          ? `/api/seller/moderation?streamId=${encodeURIComponent(streamId)}&userId=${encodeURIComponent(userId)}`
          : "/api/seller/moderation",
        {
          method: mutedIds.has(userId) ? "DELETE" : "POST",
          headers: { "Content-Type": "application/json" },
          body: mutedIds.has(userId)
            ? undefined
            : JSON.stringify({ streamId, userId }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Mute failed.");
      } else if (mutedIds.has(userId)) {
        // Optimistic for unmute; the realtime DELETE will confirm/refute.
        setMutedIds((prev) => {
          const next = new Set(prev);
          next.delete(userId);
          return next;
        });
      }
    } catch {
      setError("Mute failed (network).");
    } finally {
      setPendingAction(null);
    }
  }

  async function deleteMessage(messageId: string) {
    setPendingAction(`delete:${messageId}`);
    setError(null);
    try {
      const res = await fetch("/api/seller/moderation/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ streamId, messageId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Delete failed.");
      }
      // The realtime UPDATE handler above marks the row as Removed locally.
    } catch {
      setError("Delete failed (network).");
    } finally {
      setPendingAction(null);
    }
  }

  async function confirmBan() {
    if (!confirmingBan) return;
    const { userId } = confirmingBan;
    setConfirmingBan(null);
    setPendingAction(`ban:${userId}`);
    setError(null);
    try {
      const res = await fetch("/api/seller/moderation/ban", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ streamId, userId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Ban failed.");
      } else {
        setBannedIds((prev) => new Set(prev).add(userId));
      }
    } catch {
      setError("Ban failed (network).");
    } finally {
      setPendingAction(null);
    }
  }

  // Newest at the bottom (a chat timeline, not the bullet window). The seller
  // scrolls down to watch activity as it lands.
  const timeline = useMemo(() => messages, [messages]);

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h3 className="font-semibold text-ink">Live chat moderation</h3>
          <p className="text-xs text-slate-500">
            You see everything &mdash; including muted users&#39; attempts.
          </p>
        </div>
      </div>

      {error ? (
        <div className="card p-2 mb-2 bg-rose-50 border-rose-200 text-xs text-rose-700">
          {error}
        </div>
      ) : null}

      <div
        ref={feedRef}
        className="card divide-y divide-slate-100 overflow-y-auto max-h-[420px]"
      >
        {timeline.length === 0 ? (
          <p className="p-4 text-sm text-slate-400">
            No messages yet. While you&#39;re live, viewer messages appear
            here as they&#39;re posted.
          </p>
        ) : (
          timeline.map((m) => {
            const isMuted = mutedIds.has(m.user_id);
            const isBanned = bannedIds.has(m.user_id);
            const isRemoved = m.deleted_at != null;
            const name = m.profiles?.display_name ?? "Anonymous";
            return (
              <div key={m.id} className="p-3">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-medium text-slate-700">
                    {name}
                  </span>
                  {isMuted ? (
                    <span className="badge bg-amber-100 text-amber-700">
                      muted
                    </span>
                  ) : null}
                  {isBanned ? (
                    <span className="badge bg-rose-100 text-rose-700">
                      banned
                    </span>
                  ) : null}
                  <span className="text-[11px] text-slate-400 ml-auto">
                    {timeAgo(m.created_at)}
                  </span>
                </div>
                <p
                  className={
                    isRemoved
                      ? "mt-1 text-sm text-slate-400 italic line-through"
                      : "mt-1 text-sm text-ink"
                  }
                >
                  {isRemoved ? "Removed by seller" : m.message}
                </p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    className="btn-secondary !py-1 !px-2 text-xs"
                    disabled={pendingAction?.endsWith(`:${m.user_id}`)}
                    onClick={() => toggleMute(m.user_id)}
                  >
                    {pendingAction === `mute:${m.user_id}`
                      ? "Muting…"
                      : pendingAction === `unmute:${m.user_id}`
                        ? "Unmuting…"
                        : isMuted
                          ? "Unmute user"
                          : "Mute user"}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary !py-1 !px-2 text-xs text-rose-700"
                    disabled={
                      isBanned || pendingAction === `ban:${m.user_id}`
                    }
                    onClick={() =>
                      setConfirmingBan({ userId: m.user_id, displayName: name })
                    }
                  >
                    {pendingAction === `ban:${m.user_id}`
                      ? "Banning…"
                      : "Ban user"}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary !py-1 !px-2 text-xs"
                    disabled={
                      isRemoved || pendingAction === `delete:${m.id}`
                    }
                    onClick={() => deleteMessage(m.id)}
                  >
                    {pendingAction === `delete:${m.id}`
                      ? "Deleting…"
                      : "Delete message"}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* ── Ban confirmation modal ──
          Ban is a one-way action (we don't surface unban in this console:
          that would be a future "moderation history" view). The confirm step
          spells out that the user will be kicked + refused a token to rejoin. */}
      {confirmingBan ? (
        <div
          className="absolute inset-0 z-modal flex items-center justify-center bg-black/60"
          onClick={() => setConfirmingBan(null)}
        >
          <div
            className="card p-5 max-w-sm w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-semibold text-lg text-ink">Ban this user?</h3>
            <p className="mt-2 text-sm text-slate-600">
              <span className="font-medium">
                {confirmingBan.displayName}
              </span>{" "}
              will be removed from the LiveKit room immediately and refused a
              token to rejoin this stream. This is recorded with your name as
              the banning seller.
            </p>
            <div className="mt-4 flex gap-2 justify-end">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setConfirmingBan(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-danger"
                onClick={confirmBan}
              >
                Ban & remove
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
