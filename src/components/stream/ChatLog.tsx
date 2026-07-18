"use client";

import { useEffect, useRef } from "react";
import type { ChatMessageWithUser } from "@/lib/types";
import { useModeration } from "@/components/stream/ModerationMenu";
import { escapeForRender } from "@/lib/sanitize";
import { timeAgo } from "@/lib/utils";

interface ChatLogProps {
  /** Messages already filtered for blocked users (StreamView owns block list). */
  messages: ChatMessageWithUser[];
  onClose: () => void;
}

/**
 * Full chat-log overlay (step 4): the real conversation reader, toggled from
 * BottomActionBar's message icon. The bullet view is atmosphere only; this is
 * where a viewer actually reads the conversation.
 *
 * Moderation (P2-E): `messages` arrives already filtered for blocked users.
 * Here we additionally drop muted users (session-local, from the moderation
 * context). Each message is long-pressable to open the ModerationMenu targeting
 * its author — the primary entry point for block/mute/report from chat.
 */
export default function ChatLog({ messages, onClose }: ChatLogProps) {
  const mod = useModeration();
  const mutedIds = mod?.mutedIds ?? new Set<string>();
  const openModeration = mod?.openModeration;

  const scrollRef = useRef<HTMLDivElement>(null);
  // Keep scrolled to the latest while open.
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  const visible = messages.filter((m) => !mutedIds.has(m.user_id));

  return (
    <div className="absolute inset-x-0 bottom-0 z-hud flex h-[55%] flex-col rounded-t-xl bg-black/80 backdrop-blur-md">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="text-xs font-medium text-white">Live chat</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close chat"
          className="text-white/70 transition hover:text-white"
        >
          ✕
        </button>
      </div>
      <div
        ref={scrollRef}
        className="flex-1 space-y-1.5 overflow-y-auto p-3 text-sm"
      >
        {visible.length === 0 ? (
          <p className="text-xs text-white/50">No messages yet. Say hi 👋</p>
        ) : (
          visible.map((m) => (
            <div
              key={m.id}
              className="leading-snug"
              onContextMenu={(e) => {
                // Long-press on mobile often surfaces as contextmenu; also the
                // desktop right-click. Opens the moderation menu for the author.
                e.preventDefault();
                openModeration?.({
                  userId: m.user_id,
                  displayName: m.profiles?.display_name ?? null,
                  messageId: m.id,
                });
              }}
            >
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
  );
}
