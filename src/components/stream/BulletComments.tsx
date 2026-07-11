"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatMessageWithUser } from "@/lib/types";

const MAX_VISIBLE = 4;
const VISIBLE_MS = 4000; // fully visible before starting to fade
const FADE_MS = 500; // fade-out duration, matches bullet-out keyframe

interface BulletCommentsProps {
  /** Newest-first window of messages to show as ambient bullets (FIFO). */
  messages: ChatMessageWithUser[];
}

interface VisibleItem {
  key: string;
  name: string;
  text: string;
  leaving: boolean;
}

/**
 * Ambient "bullet" comment pills — the Douyin-style fading chat overlay. This is
 * atmosphere, NOT a conversation reader: only the most recent few messages show,
 * each fading out after ~4s. The full chat log stays reachable via the message
 * icon in BottomActionBar (StreamView owns that overlay).
 *
 * `messages` is expected newest-first. We take the last MAX_VISIBLE distinct ids
 * into a FIFO queue; when a new one arrives beyond the cap, the oldest starts
 * leaving. Each item runs its own leave timer.
 */
export default function BulletComments({ messages }: BulletCommentsProps) {
  const [items, setItems] = useState<VisibleItem[]>([]);
  // Track which message ids we've already queued so we never re-show one.
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (messages.length === 0) return;

    // messages is newest-first; walk newest→oldest, queueing ids we haven't seen.
    const newlyQueued: ChatMessageWithUser[] = [];
    for (const m of messages) {
      if (seen.current.has(m.id)) continue;
      seen.current.add(m.id);
      newlyQueued.push(m);
    }
    if (newlyQueued.length === 0) return;

    // newlyQueued is newest-first; queue oldest-of-the-new first so display
    // order reads top-to-bottom chronologically within the window.
    newlyQueued.reverse();

    setItems((prev) => {
      let next = [...prev];
      for (const m of newlyQueued) {
        const item: VisibleItem = {
          key: m.id,
          name: m.profiles?.display_name ?? "Someone",
          text: m.message,
          leaving: false,
        };
        next.push(item);
        // Cap the window: if over capacity, mark the oldest as leaving.
        while (next.filter((i) => !i.leaving).length > MAX_VISIBLE) {
          const idx = next.findIndex((i) => !i.leaving);
          if (idx === -1) break;
          next = next.map((it, i) => (i === idx ? { ...it, leaving: true } : it));
        }
      }
      return next;
    });
  }, [messages]);

  // Schedule each non-leaving item to start leaving after VISIBLE_MS, and to be
  // removed from the DOM after VISIBLE_MS + FADE_MS.
  useEffect(() => {
    const leaveTimers: ReturnType<typeof setTimeout>[] = [];
    const removeTimers: ReturnType<typeof setTimeout>[] = [];

    for (const item of items) {
      if (item.leaving) continue;
      leaveTimers.push(
        setTimeout(() => {
          setItems((prev) =>
            prev.map((it) => (it.key === item.key ? { ...it, leaving: true } : it)),
          );
        }, VISIBLE_MS),
      );
      removeTimers.push(
        setTimeout(() => {
          setItems((prev) => prev.filter((it) => it.key !== item.key));
        }, VISIBLE_MS + FADE_MS),
      );
    }

    return () => {
      leaveTimers.forEach(clearTimeout);
      removeTimers.forEach(clearTimeout);
    };
  }, [items]);

  if (items.length === 0) return null;

  return (
    <div className="pointer-events-none absolute bottom-[150px] left-[12px] right-[120px] z-10 flex flex-col gap-1">
      {items.map((item) => (
        <div
          key={item.key}
          style={{
            animation: item.leaving
              ? `bullet-out ${FADE_MS}ms ease-out forwards`
              : `bullet-in 250ms ease-out`,
          }}
          className="inline-flex w-fit max-w-full items-center gap-1.5 rounded-full bg-black/30 px-2 py-0.5 backdrop-blur-sm"
        >
          <span className="shrink-0 text-[11px] font-medium text-sky-300">
            {item.name}:
          </span>
          <span className="truncate text-[11px] text-white">{item.text}</span>
        </div>
      ))}
    </div>
  );
}
