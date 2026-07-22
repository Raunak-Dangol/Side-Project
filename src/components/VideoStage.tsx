"use client";

import {
  LiveKitRoom,
  VideoConference,
  GridLayout,
  ParticipantTile,
  RoomAudioRenderer,
  useConnectionState,
  useTracks,
} from "@livekit/components-react";
import { Track } from "livekit-client";
import { useCallback, useEffect, useState } from "react";

interface VideoStageProps {
  token: string;
  serverUrl: string | undefined;
  /** Sellers publish audio+video; viewers only subscribe. */
  role: "seller" | "viewer";
  roomName: string;
  /**
   * Drives the LiveKit `connect` prop. Defaults to true so the detail page
   * connects immediately. StreamRoom already conditionally mounts VideoStage
   * only when active+token; this is a second defensive layer.
   */
  active?: boolean;
  /**
   * §9.A — reports LiveKit's own connection lifecycle up to StreamRoom so the
   * resilience overlay can reflect "reconnecting" / "buffering" / "connected"
   * without StreamRoom plumbing LiveKit itself. Fired on every Room state
   * transition (Disconnected / Connecting / Connected / Reconnecting /
   * SignalReconnecting).
   */
  onLiveKitState?: (state: LiveKitConnState) => void;
}

/** The slice of LiveKit's ConnectionState that we surface to the parent. */
export type LiveKitConnState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "signalReconnecting"
  | "buffering";

/**
 * Minimal viewer track layout — shows the dominant speaker. Also reports a
 * "buffering" state (room connected, no subscribed track yet) so the parent's
 * §9.A overlay can show a subtle spinner instead of "waiting…" text alone.
 */
function SpeakerTrack({ onState }: { onState?: (s: LiveKitConnState) => void }) {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: true },
  );

  useEffect(() => {
    if (tracks.length === 0) onState?.("buffering");
    else onState?.("connected");
  }, [tracks.length, onState]);

  if (tracks.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-400 text-sm bg-slate-900 rounded">
        Waiting for the seller&rsquo;s video&hellip;
      </div>
    );
  }
  // Prefer screen share, else first camera track.
  const main = tracks.find((t) => t.source === Track.Source.ScreenShare) ?? tracks[0]!;
  return (
    <div className="flex-1 min-h-0 rounded overflow-hidden bg-black">
      <GridLayout tracks={[main]}>
        <ParticipantTile />
      </GridLayout>
    </div>
  );
}

/**
 * Lives inside `<LiveKitRoom>` (its context) so it can read the room's live
 * ConnectionState via the `useConnectionState` hook — the only documented way
 * to observe Reconnecting, since `LiveKitRoom` doesn't expose onReconnecting.
 * Forwards transitions up to VideoStage → StreamRoom.
 */
function LiveKitStateBridge({
  onLiveKitState,
}: {
  onLiveKitState?: (s: LiveKitConnState) => void;
}) {
  const state = useConnectionState();
  useEffect(() => {
    switch (state) {
      case "disconnected":
        onLiveKitState?.("disconnected");
        break;
      case "connecting":
        onLiveKitState?.("connecting");
        break;
      case "connected":
        onLiveKitState?.("connected");
        break;
      case "reconnecting":
        onLiveKitState?.("reconnecting");
        break;
      case "signalReconnecting":
        // Signal-layer only — for the viewer it reads as "reconnecting".
        onLiveKitState?.("reconnecting");
        break;
    }
  }, [state, onLiveKitState]);
  return null;
}

export default function VideoStage({
  token,
  serverUrl,
  role,
  roomName,
  active,
  onLiveKitState,
}: VideoStageProps) {
  // Seller-only: we probe camera/mic permission BEFORE LiveKitRoom tries to
  // publish. <VideoConference> + the video/audio props lean on livekit-client's
  // implicit createLocalTracks, which swallows a NotAllowedError/NotReadableError
  // and leaves the room pegged at "connecting" forever — the exact symptom
  // ("connecting to stream…" that never resolves) we're debugging. By probing
  // up front we can surface the real cause as `failed` with a useful message.
  const [permError, setPermError] = useState<string | null>(null);

  const handleError = useCallback(
    (e: unknown) => {
      // A hard transport error — surface it so the parent can show Failed
      // instead of silently stalling on "connecting…".
      console.error("[livekit] room error", e);
      onLiveKitState?.("disconnected");
    },
    [onLiveKitState],
  );

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- deactivation
     * teardown: clearing a stale permission-probe result on role/active change
     * is a lifecycle side-effect, not a render-derivable value (same pattern
     * as StreamRoom's deactivation teardown). */
    if (role !== "seller" || !active) {
      // Clear any prior probe result so re-entering seller mode re-runs it.
      setPermError(null);
      return;
    }
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ video: true, audio: true })
      // Stop the tracks immediately — LiveKit will re-acquire them on publish.
      // This probe is purely to detect a permission/device error early.
      .then((stream) => stream.getTracks().forEach((t) => t.stop()))
      .catch((e: unknown) => {
        if (cancelled) return;
        const name = e instanceof Error ? e.name : "";
        const msg =
          name === "NotAllowedError"
            ? "Camera/mic access was denied. Allow access in your browser and retry."
            : name === "NotFoundError" || name === "OverconstrainedError"
              ? "No camera or microphone was found on this device."
              : name === "NotReadableError"
                ? "Your camera or mic is in use by another app (e.g. Zoom, Teams). Close it and retry."
                : "Couldn't access your camera or microphone.";
        console.error("[livekit] media permission probe failed", e);
        setPermError(msg);
        // Tell the parent we're not connected so the resilience overlay
        // surfaces the failure instead of idling on "connecting…".
        onLiveKitState?.("disconnected");
      });
    return () => {
      cancelled = true;
    };
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [role, active, onLiveKitState]);

  // If the seller's camera/mic is blocked, don't bother mounting LiveKitRoom
  // (it would connecting-loop forever). The parent overlay shows the reason.
  if (role === "seller" && permError) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-300 text-sm bg-slate-900 rounded p-4 text-center">
        {permError}
      </div>
    );
  }

  return (
    <LiveKitRoom
      token={token}
      serverUrl={serverUrl}
      connect={active ?? true}
      video={role === "seller"}
      audio={role === "seller"}
      options={{
        adaptiveStream: true,
        dynacast: true,
      }}
      className="flex flex-col h-full gap-2"
      data-lk-purpose={role}
      onDisconnected={() => onLiveKitState?.("disconnected")}
      onError={handleError}
    >
      <LiveKitStateBridge onLiveKitState={onLiveKitState} />
      {/* Seller sees the full VideoConference (their own camera controls); */}
      {/* viewers only see the speaker tile, which also reports buffering. */}
      {role === "seller" ? (
        <VideoConference />
      ) : (
        <SpeakerTrack onState={onLiveKitState} />
      )}

      {/* Viewers still need to hear the seller. */}
      {role === "viewer" ? <RoomAudioRenderer /> : null}
    </LiveKitRoom>
  );
}
