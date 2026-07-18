"use client";

export type ConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "buffering"
  | "failed";

interface ConnectionOverlayProps {
  state: ConnectionState;
  /** Detail message for reconnecting/failed (e.g. "your network" vs "creator's"). */
  reason?: string;
  /** Retry handler; only meaningful in the `failed` state. */
  onRetry?: () => void;
}

/**
 * Connection-state overlay for the immersive stream view (plan §9.A). Sits over
 * the cinema canvas whenever the video isn't confidently live — never a silent
 * black screen.
 *
 *   connecting   — first token fetch in flight          → spinner + "Connecting"
 *   reconnecting — token fetch failed, backoff in flight → spinner + "Reconnecting"
 *   buffering    — LiveKit room up but no video track    → subtle spinner
 *   failed       — exhausted retries / hard error        → message + Retry button
 *   connected    — no overlay (caller shouldn't render)
 *
 * Presentational only. The animation is `.animate-pulse-soft`, which collapses
 * to a static state under prefers-reduced-motion (see globals.css).
 */
export default function ConnectionOverlay({
  state,
  reason,
  onRetry,
}: ConnectionOverlayProps) {
  if (state === "connected") return null;

  const copy: Record<ConnectionState, { title: string; sub?: string }> = {
    connecting: { title: "Connecting to stream…" },
    reconnecting: {
      title: "Reconnecting…",
      sub: reason ?? "Hold tight, this is usually quick.",
    },
    buffering: { title: "Buffering…", sub: "Waiting on the video feed." },
    failed: {
      title: "Couldn't connect",
      sub: reason ?? "Something went wrong. Try again in a moment.",
    },
    connected: { title: "" },
  };
  const meta = copy[state];

  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute inset-0 z-video flex flex-col items-center justify-center bg-cinema px-6 text-center"
    >
      {state !== "failed" ? (
        <div
          aria-hidden
          className="mb-4 h-9 w-9 rounded-full border-2 border-white/20 border-t-white/80 animate-pulse-soft"
        />
      ) : (
        <div className="mb-4 text-3xl" aria-hidden>
          ⚠️
        </div>
      )}
      <p className="text-sm font-medium text-white/90">{meta.title}</p>
      {meta.sub ? (
        <p className="mt-1 max-w-[16rem] text-xs text-white/50">{meta.sub}</p>
      ) : null}
      {state === "failed" && onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 rounded-full bg-white/10 px-5 py-2 text-sm font-medium text-white transition hover:bg-white/20"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
