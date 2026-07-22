"use client";

import { useEffect, useState } from "react";

const PIECE_COUNT = 30;

interface Piece {
  id: number;
  left: number; // vw start position
  x: number; // px horizontal drift
  rot: number; // deg rotation
  hue: number;
  duration: number; // ms
  delay: number; // ms
  size: number; // px
}

/**
 * Hand-rolled CSS confetti for the checkout success state (plan §4 step 4).
 * Renders ~30 absolutely-positioned pieces, each with a randomized hue,
 * horizontal drift, rotation, and fall duration — all driven by per-piece CSS
 * variables consumed by the `confetti-fall` keyframe in globals.css.
 *
 * Renders ONLY when `active` is true (caller gates on status === "paid").
 *
 * Purity: the randomization is done in a `useEffect` (not `useMemo`/during
 * render) because `Math.random()` is impure — React's rules require render to
 * be free of side effects. The effect seeds the pieces once on mount, so a
 * parent re-render doesn't re-randomize mid-animation.
 *
 * `prefers-reduced-motion`: the global media query in globals.css collapses
 * `confetti-fall` to an instant state, which means the pieces appear at their
 * final transform (translated + rotated + opacity 0) and are effectively
 * invisible — vestibular-sensitive users just see the emerald success card.
 *
 * No dependencies; pointer-events-none so it never intercepts taps on the
 * underlying return-page CTAs.
 */
export default function Confetti({ active }: { active: boolean }) {
  // Seeded in an effect (not during render) to keep the component pure.
  const [pieces, setPieces] = useState<Piece[]>([]);

  // Suppressing the lint: Math.random() is impure, so per React's rules the
  // piece generation MUST live in an effect (render must be free of side
  // effects). Block-level disable covers both the empty-reset and the seed.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!active) {
      setPieces([]);
      return;
    }
    setPieces(
      Array.from({ length: PIECE_COUNT }, (_, i) => ({
        id: i,
        left: Math.random() * 100,
        x: (Math.random() - 0.5) * 200,
        rot: (Math.random() - 0.5) * 720,
        hue: Math.floor(Math.random() * 360),
        duration: 2400 + Math.random() * 1600,
        delay: Math.random() * 400,
        size: 6 + Math.random() * 6,
      })),
    );
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [active]);

  if (!active || pieces.length === 0) return null;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-[60] overflow-hidden"
    >
      {pieces.map((p) => (
        <span
          key={p.id}
          className="absolute top-0 block will-change-transform"
          style={
            {
              left: `${p.left}vw`,
              width: `${p.size}px`,
              height: `${p.size * 0.6}px`,
              backgroundColor: `hsl(${p.hue}, 85%, 60%)`,
              borderRadius: "1px",
              "--c-x": `${p.x}px`,
              "--c-rot": `${p.rot}deg`,
              animation: `confetti-fall ${p.duration}ms cubic-bezier(0.16, 1, 0.3, 1) ${p.delay}ms forwards`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}
