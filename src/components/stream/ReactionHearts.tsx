"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface HeartParticle {
  /** Stable key for React's reconciliation (timestamp + counter). */
  key: number;
  /** Horizontal origin offset relative to the rail (px). */
  originX: number;
  /** End horizontal travel distance (px), randomized per particle. */
  endX: number;
  /** Bezier midpoint horizontal displacement (px). */
  curve: number;
  /** Total rise duration (ms). */
  duration: number;
  /** Final rotation (deg). */
  rotate: number;
  /** Emoji/symbol to render (♥ for heart, 🎁 for gift, etc.). */
  glyph: string;
  /** Scale multiplier for variety (gift particles render larger). */
  scale: number;
}

const MAX_PARTICLES = 30;

/**
 * Rising reaction-heart particle system (plan §3.4, §7). The hook owns the
 * particle list and exposes `emit()` (single heart) and `burst()` (a fan of
 * hearts over ~300ms) for the parent to call from tap / long-press handlers.
 * It also returns `<ReactionHeartsLayer>`'s props so the parent can mount the
 * visual layer once at z-interactive.
 *
   Particles spawn from the heart button's vertical center (`originY`), rise
   ~75vh along a randomized bezier, and fade. Capped at MAX_PARTICLES with FIFO
 * eviction to bound DOM size. pointer-events-none so taps pass through to the
 * rail/video underneath.
 *
 * Reduced-motion: the global media query in globals.css collapses heart-rise to
 * an instant state, so particles appear and vanish without motion.
 */
export function useReactionHearts(originY: number) {
  const [particles, setParticles] = useState<HeartParticle[]>([]);
  const counterRef = useRef(0);

  const spawn = useCallback((glyph: string, scale: number) => {
    const key = Date.now() + counterRef.current++;
    const particle: HeartParticle = {
      key,
      originX: randInt(-8, 8),
      endX: randInt(-60, 60),
      curve: randInt(-40, 40),
      duration: randInt(1900, 2600),
      rotate: randInt(-25, 25),
      glyph,
      scale,
    };
    setParticles((prev) => {
      const next = [...prev, particle];
      return next.length > MAX_PARTICLES
        ? next.slice(next.length - MAX_PARTICLES)
        : next;
    });
    // Self-clean after the rise completes (+ buffer) so the list doesn't grow.
    setTimeout(() => {
      setParticles((prev) => prev.filter((p) => p.key !== key));
    }, particle.duration + 250);
  }, []);

  const emit = useCallback(
    (glyph = "♥", scale = 1) => spawn(glyph, scale),
    [spawn],
  );
  const burst = useCallback(
    (count = 5, glyph = "♥") => {
      // Spread the burst over ~300ms so it reads as a fan, not a flash.
      for (let i = 0; i < count; i++) {
        const scale = 0.9 + Math.random() * 0.5;
        setTimeout(() => spawn(glyph, scale), i * 55);
      }
    },
    [spawn],
  );

  // Clear any particles on unmount so timers don't fire into a gone component.
  useEffect(() => {
    return () => setParticles([]);
  }, []);

  return { particles, originY, emit, burst };
}

/**
 * Render the particle overlay. Mounted once by the rail at z-interactive.
 * `aria-hidden` because the hearts are purely decorative — the rail's buttons
 * already carry accessible labels for the actual reaction action.
 */
export function ReactionHeartsLayer({
  particles,
  originY,
}: {
  particles: HeartParticle[];
  originY: number;
}) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-interactive overflow-hidden"
    >
      {particles.map((p) => (
        <span
          key={p.key}
          className="absolute select-none will-change-transform"
          style={
            {
              // Origin: anchored to the right edge near the rail, at originY.
              right: `${30 - p.originX}px`,
              top: `${originY}px`,
              fontSize: `${22 * p.scale}px`,
              color: "#ff4d6d",
              textShadow: "0 1px 2px rgba(0,0,0,0.4)",
              // CSS variables consumed by the heart-rise keyframe (globals.css).
              "--hx": `${p.endX}px`,
              "--hcurve": `${p.curve}px`,
              "--hrotate": `${p.rotate}deg`,
              animation: `heart-rise ${p.duration}ms cubic-bezier(0.16, 1, 0.3, 1) forwards`,
            } as React.CSSProperties
          }
        >
          {p.glyph}
        </span>
      ))}
    </div>
  );
}

function randInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min));
}
