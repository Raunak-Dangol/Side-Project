"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import VideoStage, { type LiveKitConnState } from "@/components/VideoStage";
import { publicEnv } from "@/lib/env";
import type { Stream } from "@/lib/types";

interface StreamRoomProps {
  stream: Stream;
  role: "seller" | "viewer";
  viewerId: string | null;
  viewerName?: string;
  /**
   * When false (feed context), no token is fetched and no video is mounted —
   * the room is fully disconnected. Defaults to true so the `/stream/[id]`
   * detail page keeps its immediate-connect behavior.
   */
  active?: boolean;
  /**
   * Notifies the parent of the aggregated connection state so StreamView can
   * render the §9.A resilience overlay (connecting/reconnecting/buffering/
   * failed). Called on every transition.
   */
  onConnectionStateChange?: (state: StreamConnState) => void;
  /** Bumped by the parent to force a retry after a Failed state. */
  retryToken?: number;
}

interface TokenResponse {
  token: string;
}

/** Aggregated connection state surfaced to StreamView for the resilience overlay. */
export type StreamConnState =
  | "connecting" // initial token fetch in flight
  | "connected" // token fetched + LiveKit room connected + video present
  | "reconnecting" // token fetch failed (backoff), or LiveKit is reconnecting
  | "buffering" // LiveKit room up but no speaker track yet
  | "failed"; // token fetch exhausted retries, or LiveKit signalled a hard error

/** Exponential backoff cadence for token-fetch retries, in ms. 2s → 4s → 8s → 16s. */
const BACKOFF_MS = [2_000, 4_000, 8_000, 16_000];
/** Distinguish "your network dropped" vs "creator dropped" for the reconnect copy. */
function classifyError(message: string): "yours" | "creator" {
  // 5xx from the token route most often means the server can't reach LiveKit
  // (creator-side / LiveKit health), not the viewer's network.
  return /server|livekit|upstream|5\d\d/i.test(message) ? "creator" : "yours";
}

/**
 * Fetches a scoped LiveKit token from the server (tokens are NEVER generated in
 * the browser — the API secret is server-side only), then mounts the stage.
 *
 * §9.A — connection state machine. The previous single-shot fetch is replaced
 * with an exponential-backoff retry so a transient network blip never strands
 * the viewer on a dead "error" screen:
 *
 *   connecting → (ok)        → connected (hands off to VideoStage)
 *   connecting → (throw)    → reconnecting → backoff → retry → ...
 *                                        └─ after BACKOFF_MS.length tries → failed
 *   failed → parent bumps `retryToken` → reset to connecting and try again
 *
 * The `active`-prop one-connection invariant is preserved: when `active` is
 * false no token is requested and any in-flight fetch is aborted. The token
 * fetch stays abortible so rapid scrolling can't let a stale response reconnect
 * a stream after it has deactivated.
 */
export default function StreamRoom({
  stream,
  role,
  viewerId,
  viewerName,
  active,
  onConnectionStateChange,
  retryToken,
}: StreamRoomProps) {
  const isActive = active ?? true;
  const [token, setToken] = useState<string | null>(null);
  const [state, setState] = useState<StreamConnState>(isActive ? "connecting" : "connecting");
  // LiveKit-side connection state — reported by VideoStage via onLiveKitState.
  // We aggregate it with the token-fetch state to produce `state` for the parent.
  const [livekitConn, setLiveKitConn] = useState<LiveKitConnState>("disconnected");
  // Reason string surfaced for the reconnect copy ("your network" vs "creator").
  const [failReason, setFailReason] = useState<string | null>(null);

  // The parent's connection-state callback is held in a ref so setStateNotify
  // can stay identity-stable. The connection effect (below) depends on
  // setStateNotify; if it were derived from onConnectionStateChange directly,
  // any parent that passed an inline arrow would churn the callback's identity
  // on every render and tear down the connection effect — unmounting VideoStage
  // mid-handshake and looping "Client initiated disconnect". Reading via ref
  // decouples connection lifecycle from the callback's identity entirely.
  const onConnectionStateChangeRef = useRef(onConnectionStateChange);
  useEffect(() => {
    onConnectionStateChangeRef.current = onConnectionStateChange;
  });

  const setStateNotify = useCallback(
    (next: StreamConnState, reason?: string) => {
      setState(next);
      if (reason !== undefined) setFailReason(reason);
      onConnectionStateChangeRef.current?.(next);
    },
    [], // stable — reads the callback via ref, see onConnectionStateChangeRef
  );

  // ── Token fetch with exponential backoff ────────────────────────────────
  // attemptRef.inFlight guards against overlapping retries; on unmount / stream
  // change we abort the fetch and clear any pending backoff timer.
  const attemptRef = useRef<{ inFlight: boolean; count: number }>({
    inFlight: false,
    count: 0,
  });
  const backoffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Self-reference: `doFetch` schedules itself via the backoff timer. Use a
  // ref so the timer's closure calls the latest instance without tripping the
  // "accessed before declared" rule, which keeps `doFetch` itself a leaf.
  const doFetchRef = useRef<(attempt: number) => void>(() => {});

  const doFetch = useCallback(
    async (attempt: number): Promise<void> => {
      if (attemptRef.current.inFlight) return;
      attemptRef.current.inFlight = true;
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch("/api/livekit-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            streamId: stream.id,
            role,
            // Anonymous viewers get a synthetic identity so LiveKit still works.
            identity:
              role === "seller"
                ? `seller-${viewerId}`
                : viewerId
                  ? `viewer-${viewerId}`
                  : `viewer-anon-${Math.random().toString(36).slice(2, 10)}`,
            name: viewerName,
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `Stream token request failed (${res.status})`);
        }
        const data = (await res.json()) as TokenResponse;
        attemptRef.current = { inFlight: false, count: 0 };
        setToken(data.token);
        // The Room is now waiting to connect; VideoStage's onLiveKitState will
        // drive the connected/buffering transitions.
        setStateNotify("connecting");
      } catch (e) {
        attemptRef.current.inFlight = false;
        if (controller.signal.aborted) return; // expected on deactivate/scroll
        const message = e instanceof Error ? e.message : "Network error";
        // Schedule the next attempt with exponential backoff, or hard-fail.
        if (attempt < BACKOFF_MS.length) {
          setStateNotify("reconnecting", classifyError(message) === "yours"
            ? "Your network connection seems unstable."
            : "The stream's server is having trouble.");
          const delay = BACKOFF_MS[attempt];
          backoffTimerRef.current = setTimeout(() => {
            backoffTimerRef.current = null;
            doFetchRef.current(attempt + 1);
          }, delay);
        } else {
          setStateNotify("failed", message);
        }
      }
    },
    [stream.id, role, viewerId, viewerName, setStateNotify],
  );
  // Keep the self-reference ref in sync so backoff timers call the latest
  // `doFetch` instance (its deps may change across renders).
  useEffect(() => {
    doFetchRef.current = doFetch;
  }, [doFetch]);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- deactivation teardown +
     * lifecycle kick: the token MUST drop on `active` flipping false so the
     * stage unmounts, and the connecting signal on (re)start is the visible
     * signal to the resilience overlay. Computing these during render would
     * race the backoff timer cleanup above and re-mount the stage one commit
     * late. */
    if (!isActive) {
      // Cancel anything pending, drop the token so VideoStage unmounts. We do
      // NOT clear `state` here -- the parent slides this view out, so its
      // state is irrelevant while inactive.
      abortRef.current?.abort();
      if (backoffTimerRef.current) {
        clearTimeout(backoffTimerRef.current);
        backoffTimerRef.current = null;
      }
      attemptRef.current = { inFlight: false, count: 0 };
      setToken(null);
      return;
    }

    // (Re)start a fresh fetch sequence -- covers initial mount, stream change,
    // and the parent's retryToken bump after a Failed state.
    attemptRef.current = { inFlight: false, count: 0 };
    setStateNotify("connecting");
    doFetchRef.current(0);

    return () => {
      abortRef.current?.abort();
      if (backoffTimerRef.current) {
        clearTimeout(backoffTimerRef.current);
        backoffTimerRef.current = null;
      }
      attemptRef.current = { inFlight: false, count: 0 };
      setToken(null);
    };
    /* eslint-enable react-hooks/set-state-in-effect */
    // retryToken intentionally triggers a fresh sequence on a Failed state.
    // doFetch is invoked via its ref, so it's intentionally absent from deps.
  }, [isActive, stream.id, role, viewerId, viewerName, retryToken, setStateNotify]);

  // ── Aggregate token-fetch + LiveKit connection states for the parent ──
  // Precedence: hard-failed token > LiveKit-side reconnecting/buffering >
  // token connecting > connected (no overlay). This effect both derives an
  // aggregated state AND fires `onConnectionStateChange` to the parent as a
  // side-effect (prop callback), so it isn't pure derivation and can't be a
  // useMemo. The lint fires on the first setStateNotify call; a single
  // block-level disable covers all four branches.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    // Token-fetch hard-failed (exhausted all backoffs) — keep showing Failed
    // until the parent bumps retryToken. A token-fetch backoff (reconnecting)
    // does NOT block here: during backoff `token` is null so the guard below
    // returns before we reach this state machine. The previous guard
    // `state === "reconnecting"` was a bug — it blocked LiveKit's own
    // disconnected→connected transition forever, leaving the viewer stuck on
    // "Reconnecting…" even after the room connected (audio played fine).
    if (state === "failed") return;
    if (!token) return; // still fetching the token -> state already "connecting"
    if (livekitConn === "reconnecting" || livekitConn === "signalReconnecting") {
      setStateNotify("reconnecting", "Reconnecting to the live stream...");
    } else if (livekitConn === "disconnected") {
      setStateNotify("reconnecting", "Connection dropped. Reconnecting...");
    } else if (livekitConn === "buffering" || livekitConn === "connecting") {
      setStateNotify("buffering");
    } else if (livekitConn === "connected") {
      setStateNotify("connected");
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [livekitConn, token, state, setStateNotify]);

  return (
    <div className="h-full">
      {token ? (
        <VideoStage
          token={token}
          serverUrl={publicEnv.livekitUrl}
          role={role}
          roomName={stream.livekit_room_name}
          sellerId={stream.seller_id}
          active={isActive}
          onLiveKitState={setLiveKitConn}
        />
      ) : null}
    </div>
  );
}
