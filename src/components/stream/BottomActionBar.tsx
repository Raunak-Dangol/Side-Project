"use client";

import { useState } from "react";

interface BottomActionBarProps {
  streamId: string;
  /** Opens the full chat-log overlay (owned by StreamView). */
  onOpenChat: () => void;
  /** Sends a gift reaction (delegates to the same flush path as the rail). */
  onSendGift: () => void;
}

/**
 * Bottom action bar: chat input + gift/message/more icons. The chat input is the
 * SAME write path as the legacy ChatPanel — POST /api/chat with { streamId,
 * message } — just styled to fit the Douyin overlay. On success the new message
 * arrives via the realtime subscription owned by StreamView (so it shows up in
 * both the bullet view and the full chat log) and the input clears.
 */
export default function BottomActionBar({
  streamId,
  onOpenChat,
  onSendGift,
}: BottomActionBarProps) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || pending) return;
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
    <div className="absolute bottom-[50px] left-[12px] right-[12px] z-10">
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

        {/* Gift — triggers the gift reaction (no virtual-currency economy). */}
        <button
          type="button"
          aria-label="Send gift"
          onClick={onSendGift}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/40 text-base text-white backdrop-blur-sm transition hover:bg-black/60 active:scale-90"
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

        {/* More — placeholder, no real menu in the prototype. */}
        {/* TODO (post-prototype): overflow menu (share, report, etc.) */}
        <button
          type="button"
          aria-label="More"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/40 text-base text-white backdrop-blur-sm transition hover:bg-black/60"
        >
          ⋯
        </button>
      </form>
      {error ? (
        <p className="mt-1 px-2 text-[10px] text-rose-300">{error}</p>
      ) : null}
    </div>
  );
}
