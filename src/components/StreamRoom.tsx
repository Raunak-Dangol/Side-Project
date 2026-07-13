"use client";

import { useEffect, useState } from "react";
import VideoStage from "@/components/VideoStage";
import { publicEnv } from "@/lib/env";
import type { Stream } from "@/lib/types";

interface StreamRoomProps {
  stream: Stream;
  role: "seller" | "viewer";
  viewerId: string | null;
  viewerName?: string;
}

interface TokenResponse {
  token: string;
}

/**
 * Fetches a scoped LiveKit token from the server (tokens are NEVER generated in
 * the browser — the API secret is server-side only), then mounts the stage.
 *
 * A viewer who isn't signed in still sees the video but can't chat/buy (the
 * chat panel and buy button guard that separately). For the prototype we still
 * issue a viewer token to anonymous visitors so they can watch.
 */
export default function StreamRoom({
  stream,
  role,
  viewerId,
  viewerName,
}: StreamRoomProps) {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/livekit-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
          throw new Error(body.error ?? "Failed to get stream token");
        }
        const data = (await res.json()) as TokenResponse;
        if (!cancelled) setToken(data.token);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Stream error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [stream.id, role, viewerId, viewerName]);

  if (error) {
    return (
      <div className="h-full flex items-center justify-center text-white/80 text-sm p-4 text-center">
        {error}
      </div>
    );
  }
  if (!token) {
    return (
      <div className="h-full flex items-center justify-center text-white/60 text-sm">
        Connecting to stream…
      </div>
    );
  }

  return (
    <div className="h-full">
      <VideoStage
        token={token}
        serverUrl={publicEnv.livekitUrl}
        role={role}
        roomName={stream.livekit_room_name}
      />
    </div>
  );
}
