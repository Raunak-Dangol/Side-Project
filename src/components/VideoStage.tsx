"use client";

import {
  LiveKitRoom,
  VideoConference,
  GridLayout,
  ParticipantTile,
  RoomAudioRenderer,
  useTracks,
} from "@livekit/components-react";
import { Track } from "livekit-client";
import type { Stream } from "@/lib/types";

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
}

/**
 * Minimal viewer track layout — shows the dominant speaker.
 */
function SpeakerTrack() {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: true },
  );
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

export default function VideoStage({
  token,
  serverUrl,
  role,
  roomName,
  active,
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
    >
      {/* Seller sees the full VideoConference (their own camera controls); */}
      {/* viewers only see the speaker tile. */}
      {role === "seller" ? <VideoConference /> : <SpeakerTrack />}

      {/* Viewers still need to hear the seller. */}
      {role === "viewer" ? <RoomAudioRenderer /> : null}
    </LiveKitRoom>
  );
}
