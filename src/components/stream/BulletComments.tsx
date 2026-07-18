"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatMessageWithUser } from "@/lib/types";
import { useModeration } from "@/components/stream/ModerationMenu";

const LANE_COUNT = 4; // horizontal lanes so pills don't overlap mid-drift
const MAX_PILLS = 10; // concurrent pills across all lanes
const DRIFT_MS_MIN = 6000;
const DRIFT_MS_MAX = 8000;

interface BulletCommentsProps {
  /** Newest-first window of messages to show as ambient bullets (FIFO). */
  messages: ChatMessageWithUser[];
}

interface VisibleItem {
  key: string;
  name: string;
  text: string;
  /** Horizontal lane (0 = top, LANE_COUNT-1 = bottom). */
  lane: number;
  /** Per-user background tint (deterministic from user id). */
  color: { bg: string; text: string };
}

/**
 * Ambient "bullet" (Danmu) comments — the Douyin-style drifting chat overlay
 * (plan §3.3). This is atmosphere, NOT a conversation reader: each pill enters
 * from the right edge and drifts left across one of LANE_COUNT lanes, then
 * unmounts. The full chat log stays reachable via the message icon in
 * BottomActionBar (StreamView owns that overlay).
 *
 * `messages` is expected newest-first. We take newly-arrived ids (deduped via a
 * seen-set), assign each the least-recently-used lane, and animate it across.
 * Capped at MAX_PILLS to bound DOM size.
 *
 * Per-user color: a deterministic hue derived from the user id hash, so the
 * same user always renders the same color. Backgrounds use translucent tinted
 * fills; names use a brighter shade. Both WCAG-legible over the cinema canvas.
 *
 * Accessibility: the layer is `aria-hidden` (decorative firehose — the readable
 * chat lives in the chat-log sheet) and `pointer-events-none`. Reduced-motion:
 * the global media query in globals.css collapses `bullet-drift` to an instant
 * state, so pills appear and vanish without horizontal travel.
 */
export default function BulletComments({ messages }: BulletCommentsProps) {
  const [items, setItems] = useState<VisibleItem[]>([]);
  // Track which message ids we've already shown so we never re-render one.
  const seen = useRef<Set<string>>(new Set());
  // Last-used timestamp per lane → pick the least-recently-used lane for a new
  // pill so they spread out instead of stacking.
  const laneLastUsed = useRef<number[]>(Array(LANE_COUNT).fill(0));

  // Moderation (P2-E): drop muted users from the ambient firehose. `messages`
  // arrives already filtered for blocked users (StreamView owns the block list);
  // mute is session-local and lives in the moderation context, so we apply it
  // here at the render boundary.
  const mod = useModeration();
  const mutedIds = mod?.mutedIds ?? new Set<string>();
  const visibleMessages = messages.filter((m) => !mutedIds.has(m.user_id));

  useEffect(() => {
    if (visibleMessages.length === 0) return;

    // messages is newest-first; walk newest→oldest, queueing ids we haven't seen.
    const newlyQueued: ChatMessageWithUser[] = [];
    for (const m of visibleMessages) {
      if (seen.current.has(m.id)) continue;
      seen.current.add(m.id);
      newlyQueued.push(m);
    }
    if (newlyQueued.length === 0) return;

    // Assign each new pill a lane + color, oldest-of-the-new first.
    newlyQueued.reverse();

    setItems((prev) => {
      let next = [...prev];
      for (const m of newlyQueued) {
        // Cap total concurrent pills; evict the oldest (front of the list).
        while (next.length >= MAX_PILLS) next.shift();
        const lane = pickLane(laneLastUsed.current);
        laneLastUsed.current[lane] = Date.now();
        next.push({
          key: m.id,
          name: m.profiles?.display_name ?? "Someone",
          text: m.message,
          lane,
          color: colorForUser(m.user_id),
        });
      }
      return next;
    });
  }, [visibleMessages]);

  // Each pill self-unmounts after its drift completes. One timer per pill,
  // cleared on unmount; the CSS animation handles the visual exit, we just need
  // to stop tracking the key so the list can't grow unbounded.
  useEffect(() => {
    if (items.length === 0) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const item of items) {
      // Duration varies per-pill (drift duration is randomized per key); compute
      // the same value as the render below so the cleanup matches.
      const duration = DRIFT_MS_MIN + (hash(item.key) % (DRIFT_MS_MAX - DRIFT_MS_MIN));
      timers.push(
        setTimeout(() => {
          setItems((prev) => prev.filter((it) => it.key !== item.key));
        }, duration + 100),
      );
    }
    return () => {
      timers.forEach(clearTimeout);
    };
  }, [items]);

  if (items.length === 0) return null;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute bottom-[150px] left-[12px] right-[120px] top-[150px] z-interactive overflow-hidden"
    >
      {items.map((item) => (
        <div
          key={item.key}
          className="absolute right-0 whitespace-nowrap will-change-transform"
          style={{
            top: `${item.lane * 28}px`,
            animation: `bullet-drift ${DRIFT_MS_MIN + (hash(item.key) % (DRIFT_MS_MAX - DRIFT_MS_MIN))}ms linear forwards`,
          }}
        >
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 backdrop-blur-sm"
            style={{ backgroundColor: item.color.bg, color: item.color.text }}
          >
            <span className="shrink-0 text-[11px] font-semibold">
              {item.name}:
            </span>
            <span className="text-[11px]">{item.text}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

/** Pick the lane least-recently-used so pills spread out vertically. */
function pickLane(lastUsed: number[]): number {
  let best = 0;
  let oldest = Infinity;
  for (let i = 0; i < lastUsed.length; i++) {
    if (lastUsed[i] < oldest) {
      oldest = lastUsed[i];
      best = i;
    }
  }
  return best;
}

/** Cheap string hash → uint32. Stable per id within a session. */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Deterministic per-user color. A hue from the id hash; we keep saturation and
 * lightness fixed so the palette stays legible over the dark cinema canvas.
 * Returns translucent bg + bright text shades.
 */
function colorForUser(userId: string): { bg: string; text: string } {
  const hue = hash(userId) % 360;
  return {
    bg: `hsla(${hue}, 70%, 45%, 0.55)`,
    text: `hsl(${hue}, 90%, 88%)`,
  };
}
