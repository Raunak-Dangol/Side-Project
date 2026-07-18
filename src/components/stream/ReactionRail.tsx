"use client";

import { useEffect, useRef, useState } from "react";
import { haptic } from "@/lib/haptics";
import {
  useReactionHearts,
  ReactionHeartsLayer,
} from "@/components/stream/ReactionHearts";

type ReactionKind = "heart" | "gift";

interface ReactionRailProps {
  streamId: string;
  /** Live totals broadcast from StreamView's reactions realtime subscription. */
  totals: { heart: number; gift: number };
}

/** Hold duration (ms) beyond which a heart press is treated as a burst. */
const LONG_PRESS_MS = 450;

/**
 * Floating heart/gift tap targets on the right edge (plan §3.4). Tap behaviour:
 *   - A local `useRef` counter increments immediately for instant feedback.
 *   - A 400ms scale/opacity "pop" keyframe plays on the tapped icon.
 *   - Hearts emit as rising particles via useReactionHearts; a long-press
 *     (≥450ms hold) on the heart fires a burst of 5.
 *   - Every 2s, if the pending count is >0, ONE batched POST flushes it via
 *     /api/streams/[id]/react and resets the local pending count.
 *
 * The displayed total is the authoritative realtime number (from StreamView),
 * NOT the local pending count — so on a slow network the pill always reflects
 * the server's view, while taps still feel instant.
 */
export default function ReactionRail({ streamId, totals }: ReactionRailProps) {
  const pending = useRef<{ heart: number; gift: number }>({
    heart: 0,
    gift: 0,
  });
  // Bump to re-trigger the pop animation on each tap.
  const [popHeart, setPopHeart] = useState(0);
  const [popGift, setPopGift] = useState(0);
  const [flushError, setFlushError] = useState(false);

  // Particle system — hearts rise from the heart button's vertical center. The
  // rail sits at top-[110px] with a 40px-tall button; the first button center
  // is ~110 + 20 = 130px. We emit from there.
  const hearts = useReactionHearts(130);

  function tap(kind: ReactionKind) {
    pending.current[kind] += 1;
    if (kind === "heart") {
      setPopHeart((n) => n + 1);
      hearts.emit("♥");
    } else {
      setPopGift((n) => n + 1);
      hearts.emit("🎁", 1.3);
    }
    haptic(); // instant tactile feedback per tap (no-op on desktop/iOS)
  }

  // ── Long-press burst on the heart ────────────────────────────────────────
  // On pointerdown start a timer; if it fires before pointerup, we're in
  // "burst mode" — emit a fan of hearts and re-buzz. Any subsequent move cancels
  // (so a scroll isn't misread as a hold).
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const burstedRef = useRef(false);

  function startHeartPress() {
    burstedRef.current = false;
    pressTimerRef.current = setTimeout(() => {
      burstedRef.current = true;
      hearts.burst(5, "♥");
      // 5 hearts count toward the pending batch; flush as a single amount.
      pending.current.heart += 4; // +1 from the initial tap below is folded in
      setPopHeart((n) => n + 1);
      haptic(30);
    }, LONG_PRESS_MS);
  }
  function endHeartPress() {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  }

  // Batched flush every 2s.
  useEffect(() => {
    const interval = setInterval(async () => {
      const kinds: ReactionKind[] = ["heart", "gift"];
      for (const kind of kinds) {
        const amount = pending.current[kind];
        if (amount <= 0) continue;
        pending.current[kind] = 0;
        try {
          const res = await fetch(`/api/streams/${streamId}/react`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind, amount }),
          });
          if (!res.ok) {
            // Re-queue the failed batch so it retries next tick.
            pending.current[kind] += amount;
            setFlushError(true);
          } else {
            setFlushError(false);
          }
        } catch {
          pending.current[kind] += amount;
          setFlushError(true);
        }
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [streamId]);

  return (
    <>
      <ReactionHeartsLayer particles={hearts.particles} originY={hearts.originY} />
      <div className="absolute right-[14px] top-[110px] z-interactive flex flex-col items-center gap-3">
        <ReactionButton
          icon="♥"
          label="heart"
          count={totals.heart}
          popKey={popHeart}
          onClick={() => {
            // A normal tap: if the long-press burst already fired, don't double-count.
            if (burstedRef.current) {
              burstedRef.current = false;
              return;
            }
            tap("heart");
          }}
          onPointerDown={startHeartPress}
          onPointerUp={endHeartPress}
          onPointerLeave={endHeartPress}
        />
        <ReactionButton
          icon="🎁"
          label="gift"
          count={totals.gift}
          popKey={popGift}
          onClick={() => tap("gift")}
        />
        {flushError ? (
          <span className="text-[9px] text-white/50">retrying…</span>
        ) : null}
      </div>
    </>
  );
}

function ReactionButton({
  icon,
  label,
  count,
  popKey,
  onClick,
  onPointerDown,
  onPointerUp,
  onPointerLeave,
}: {
  icon: string;
  label: string;
  count: number;
  popKey: number;
  onClick: () => void;
  onPointerDown?: () => void;
  onPointerUp?: () => void;
  onPointerLeave?: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <button
        type="button"
        aria-label={`Send ${label}`}
        onClick={onClick}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
        className="flex h-10 w-10 items-center justify-center rounded-full bg-black/35 text-lg text-gold backdrop-blur-sm transition hover:bg-black/55 active:scale-90"
      >
        {/* popKey changes on every tap → key change remounts the span → the
            reaction-pop keyframe replays from its start. */}
        <span key={popKey} style={{ animation: "reaction-pop 400ms ease-out" }}>
          {icon}
        </span>
      </button>
      {count > 0 ? (
        <span className="rounded-full bg-black/40 px-1.5 py-0.5 text-[9px] font-medium text-white">
          x{count}
        </span>
      ) : null}
    </div>
  );
}
