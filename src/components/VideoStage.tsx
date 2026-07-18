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
import { useEffect } from "react";

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
      onError={(e) => {
        // A hard transport error — surface it so the parent can show Failed.
        console.error("[livekit] room error", e);
        onLiveKitState?.("disconnected");
      }}
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
