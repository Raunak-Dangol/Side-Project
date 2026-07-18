"use client";

import { useState } from "react";
import { useAuthInterceptor } from "@/components/auth/AuthInterceptorProvider";
import { useModeration } from "@/components/stream/ModerationMenu";

interface BottomActionBarProps {
  streamId: string;
  /** Opens the full chat-log overlay (owned by StreamView). */
  onOpenChat: () => void;
  /** Sends a gift reaction (delegates to the same flush path as the rail). */
  onSendGift: () => void;
  /** The stream's seller, for the ⋯ overflow moderation menu (P2-E). */
  seller?: { id: string; display_name: string | null } | null;
}

/**
 * Bottom action bar: chat input + gift/message/more icons. The chat input is the
 * SAME write path as the legacy ChatPanel — POST /api/chat with { streamId,
 * message } — just styled to fit the Douyin overlay. On success the new message
 * arrives via the realtime subscription owned by StreamView (so it shows up in
 * both the bullet view and the full chat log) and the input clears.
 *
 * Guest gate (P2-D): chat send + gift both prompt the auth sheet for anon
 * viewers instead of firing a 401. The chat intent also opens the chat-log
 * overlay on replay so the viewer lands where they can type.
 *
 * Moderation (P2-E): the ⋯ overflow opens the ModerationMenu targeting the
 * seller (replaces the previous dead "TODO" placeholder). Message-level
 * moderation is reachable via long-press inside ChatLog.
 */
export default function BottomActionBar({
  streamId,
  onOpenChat,
  onSendGift,
  seller,
}: BottomActionBarProps) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { requireAuth } = useAuthInterceptor();
  const mod = useModeration();

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || pending) return;
    // Guest gate: anon viewers get the auth sheet, not a 401.
    if (!requireAuth({ kind: "chat", streamId })) return;
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ streamId, message: text }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Failed to send message");
        return;
      }
      setDraft("");
    } catch {
      setError("Network error");
    } finally {
      setPending(false);
    }
  }

  return (
    // bottom offset stacks on top of the home-indicator safe area so the input
    // never sits under the gesture bar on iPhones (no-op where the inset is 0).
    <div
      className="absolute left-[12px] right-[12px] z-hud"
      style={{ bottom: "calc(50px + env(safe-area-inset-bottom))" }}
    >
      <form onSubmit={send} className="flex items-center gap-2">
        {/* Chat input — same /api/chat write path as the legacy ChatPanel. */}
        <input
          className="flex-1 rounded-full border border-white/20 bg-black/40 px-3 py-2 text-xs text-white placeholder:text-white/50 backdrop-blur-sm focus:border-white/40 focus:outline-none"
          placeholder="say something…"
          value={draft}
          maxLength={500}
          onChange={(e) => setDraft(e.target.value)}
          disabled={pending}
        />

        {/* Gift — triggers the gift reaction (no virtual-currency economy).
            Guest-gated: anon viewers get the auth sheet instead of a 401. */}
        <button
          type="button"
          aria-label="Send gift"
          onClick={() => {
            if (requireAuth({ kind: "gift", streamId })) onSendGift();
          }}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/40 text-base text-gold backdrop-blur-sm transition hover:bg-black/60 active:scale-90"
        >
          🎁
        </button>

        {/* Message — opens the full chat log overlay. */}
        <button
          type="button"
          aria-label="Open chat"
          onClick={onOpenChat}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/40 text-base text-white backdrop-blur-sm transition hover:bg-black/60 active:scale-90"
        >
          💬
        </button>

        {/* More — opens the moderation menu targeting the seller (P2-E).
            Replaces the previous dead "TODO" overflow. Hidden when the
            viewer isn't signed in or there's no seller to target. */}
        {seller && seller.id ? (
          <button
            type="button"
            aria-label="More options"
            onClick={() =>
              mod?.openModeration({
                userId: seller.id,
                displayName: seller.display_name,
              })
            }
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/40 text-base text-white backdrop-blur-sm transition hover:bg-black/60 active:scale-90"
          >
            ⋯
          </button>
        ) : null}
      </form>
      {error ? (
        <p className="mt-1 px-2 text-[10px] text-rose-300">{error}</p>
      ) : null}
    </div>
  );
}
