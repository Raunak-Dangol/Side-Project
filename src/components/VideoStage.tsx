"use client";

import {
  LiveKitRoom,
  RoomAudioRenderer,
  useConnectionState,
  useLocalParticipant,
  useRoomContext,
  useTracks,
  isTrackReference,
} from "@livekit/components-react";
import {
  ConnectionState,
  RoomEvent,
  Track,
  type RemoteTrackPublication,
} from "livekit-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface VideoStageProps {
  token: string;
  serverUrl: string | undefined;
  /** Sellers publish audio+video; viewers only subscribe. */
  role: "seller" | "viewer";
  roomName: string;
  /**
   * Authoritative seller user id from the streams row. Used to match the
   * expected publisher identity (`seller-<sellerId>`) instead of a fragile
   * prefix-only guess.
   */
  sellerId: string;
  /**
   * Drives the LiveKit `connect` prop. Defaults to true so the detail page
   * connects immediately. StreamRoom already conditionally mounts VideoStage
   * only when active+token; this is a second defensive layer.
   */
  active?: boolean;
  /**
   * §9.A — reports LiveKit's own connection lifecycle up to StreamRoom so the
   * resilience overlay can reflect "reconnecting" / "buffering" / "connected"
   * without StreamRoom plumbing LiveKit itself.
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

type ViewerWaitReason =
  | "seller_absent"
  | "waiting_camera"
  | "camera_muted"
  | "loading"
  | "subscribe_failed"
  | "tap_to_play";

const WAIT_COPY: Record<ViewerWaitReason, string> = {
  seller_absent: "Seller has not joined yet…",
  waiting_camera: "Waiting for seller camera…",
  camera_muted: "Seller paused their camera",
  loading: "Loading video…",
  subscribe_failed: "Couldn't load the video. Retrying…",
  tap_to_play: "Tap to play",
};

/**
 * Decodes a LiveKit JWT payload WITHOUT verifying the signature. Used only for
 * temporary diagnostics so we can log grants (never the raw token).
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const json =
      typeof atob === "function"
        ? atob(b64)
        : Buffer.from(b64, "base64").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function logDiag(scope: "seller" | "viewer", payload: Record<string, unknown>) {
  // Temporary structured diagnostics — remove once the media path is stable.
  console.info(`[livekit:${scope}]`, payload);
}

/**
 * Seller-side: after the room is connected, explicitly enable camera + mic.
 * LiveKitRoom's `video`/`audio` props *should* create local tracks, but we
 * do not assume that — production was connecting with audio only, which is
 * consistent with a publish path that never successfully enabled camera.
 *
 * Also emits the temporary seller diagnostics the audit asked for.
 */
function SellerPublisher({
  role,
  roomName,
  sellerId,
}: {
  role: "seller" | "viewer";
  roomName: string;
  sellerId: string;
}) {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const conn = useConnectionState();
  const triedRef = useRef(false);

  useEffect(() => {
    if (role !== "seller") return;
    if (conn !== ConnectionState.Connected) return;
    if (triedRef.current) return;
    triedRef.current = true;

    let cancelled = false;
    (async () => {
      // Explicit publish — do not rely solely on LiveKitRoom video/audio props.
      try {
        await localParticipant.setCameraEnabled(true);
        await localParticipant.setMicrophoneEnabled(true);
      } catch (e) {
        console.error("[livekit:seller] setCamera/MicEnabled failed", e);
      }
      if (cancelled) return;

      const pubs = Array.from(localParticipant.trackPublications.values()).map(
        (p) => ({
          source: p.source,
          kind: p.kind,
          trackSid: p.trackSid,
          isMuted: p.isMuted,
          hasTrack: !!p.track,
          trackName: p.trackName,
        }),
      );

      logDiag("seller", {
        stage: "after_publish_attempt",
        identity: localParticipant.identity,
        expectedIdentity: `seller-${sellerId}`,
        roomName,
        connectionState: conn,
        permissions: localParticipant.permissions,
        localPublications: pubs,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [role, conn, localParticipant, roomName, sellerId, room]);

  // Reset the one-shot flag if we leave the room so a reconnect re-publishes.
  useEffect(() => {
    if (conn === ConnectionState.Disconnected) {
      triedRef.current = false;
    }
  }, [conn]);

  return null;
}

/**
 * Viewer-side: reactive single-seller video.
 *
 * Uses `useTracks` with `onlySubscribed: false` so unsubscribed publications
 * still appear (the onlySubscribed:true + adaptiveStream circular dependency
 * is what previously left viewers stuck on "Buffering"). Then:
 *   1. Filter to the authoritative seller identity (`seller-<sellerId>`).
 *   2. Prefer camera, optionally elevate screen share when present.
 *   3. Explicitly `setSubscribed(true)` on the RemoteTrackPublication.
 *   4. Render via <VideoTrack> once a real TrackReference exists.
 */
function SellerVideo({
  sellerId,
  onState,
}: {
  sellerId: string;
  onState?: (s: LiveKitConnState) => void;
}) {
  const expectedIdentity = `seller-${sellerId}`;
  const room = useRoomContext();
  const conn = useConnectionState();

  // Reactive track collection including unsubscribed pubs. Placeholders keep
  // the identity present even before a camera track is published.
  //
  // NOTE: we deliberately do NOT pass updateOnlyOn. A custom updateOnlyOn
  // REPLACES the hook's default event set, and the previous custom set was
  // missing the event that fires when `publication.track` is assigned AFTER
  // `isSubscribed` flips true — leaving the viewer stuck on "loading"
  // (isSubscribed=true but track unavailable) forever. The hook's defaults
  // already cover TrackSubscribed / TrackStreamStateChanged / etc.
  const allTracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );

  const sellerTracks = useMemo(
    () => allTracks.filter((t) => t.participant.identity === expectedIdentity),
    [allTracks, expectedIdentity],
  );

  // Prefer screen share when actively published, else camera.
  const selected = useMemo(() => {
    const screen = sellerTracks.find(
      (t) => t.source === Track.Source.ScreenShare && isTrackReference(t),
    );
    if (screen) return screen;
    const camera = sellerTracks.find(
      (t) => t.source === Track.Source.Camera && isTrackReference(t),
    );
    if (camera) return camera;
    // Placeholder (seller present, no publication yet) — any seller track ref.
    return sellerTracks[0] ?? null;
  }, [sellerTracks]);

  const publication =
    selected && isTrackReference(selected) ? selected.publication : null;
  const remotePub = publication as RemoteTrackPublication | null;

  const [subError, setSubError] = useState<string | null>(null);
  const [needsTap, setNeedsTap] = useState(false);

  // Snapshot remote participants for diagnostics + wait-reason derivation.
  // useTracks above already re-renders on the relevant RoomEvents, so reading
  // room.remoteParticipants here is current for this render.
  const remotes = useMemo(
    () =>
      Array.from(room.remoteParticipants.values()).map((p) => ({
        identity: p.identity,
        publications: Array.from(p.trackPublications.values()).map((pub) => ({
          source: pub.source,
          kind: pub.kind,
          trackSid: pub.trackSid,
          isSubscribed: pub.isSubscribed,
          isMuted: pub.isMuted,
          hasTrack: !!pub.track,
        })),
      })),
    // allTracks is the reactive dependency (RoomEvents → useTracks → re-render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [room, allTracks],
  );

  const sellerPresent = remotes.some((r) => r.identity === expectedIdentity);

  // The remote track object (RemoteVideoTrack). This is what attaches to a
  // <video> element via track.attach(). May be undefined even when isSubscribed
  // is true (Stage D). Once it exists, NativeVideo takes over and drives the
  // overlay clear via its onPlaying/onMetadata callbacks.
  const remoteTrack = remotePub?.track as
    | import("livekit-client").RemoteTrack
    | undefined;

  const waitReason: ViewerWaitReason = useMemo(() => {
    if (!sellerPresent) return "seller_absent";
    if (!publication) return "waiting_camera";
    if (publication.isMuted) return "camera_muted";
    if (subError) return "subscribe_failed";
    // Stage D guard: isSubscribed alone is NOT enough. The track object must
    // exist. Once it does, NativeVideo attaches and drives the overlay clear.
    if (!publication.isSubscribed || !publication.track) return "loading";
    if (needsTap) return "tap_to_play";
    // Ready — NativeVideo will render and drive onState("connected") on play.
    return "loading";
  }, [sellerPresent, publication, subError, needsTap]);

  // Explicit subscription — register the TrackSubscribed listener BEFORE
  // calling setSubscribed(true), and handle an already-subscribed track
  // immediately after, so a fast TrackSubscribed event can't be missed.
  useEffect(() => {
    if (!remotePub) return;

    const onTrackSubscribed = () => {
      logDiag("viewer", {
        stage: "track_subscribed",
        trackSid: remotePub.trackSid,
        hasTrack: !!remotePub.track,
      });
    };
    room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);

    if (remotePub.isSubscribed) {
      // Already subscribed (e.g. adaptiveStream had it) — handle immediately.
      logDiag("viewer", {
        stage: "already_subscribed",
        trackSid: remotePub.trackSid,
        hasTrack: !!remotePub.track,
      });
    } else {
      try {
        remotePub.setSubscribed(true);
        logDiag("viewer", {
          stage: "subscription_request_sent",
          trackSid: remotePub.trackSid,
          source: remotePub.source,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSubError(msg);
        console.error("[livekit:viewer] setSubscribed failed", e);
        logDiag("viewer", {
          stage: "subscription_failed",
          error: msg,
          trackSid: remotePub.trackSid,
        });
      }
    }

    return () => {
      room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
    };
  }, [room, remotePub]);

  // Diagnostics + parent overlay state.
  useEffect(() => {
    const mst = remotePub?.track?.mediaStreamTrack;
    logDiag("viewer", {
      stage: "track_scan",
      connectionState: conn,
      expectedIdentity,
      remoteIdentities: remotes.map((r) => r.identity),
      waitReason,
      selected: selected
        ? {
            identity: selected.participant.identity,
            source: selected.source,
            isTrackRef: isTrackReference(selected),
            // Deep publication diagnostics — the fields that determine D vs E.
            hasPublication: Boolean(publication),
            trackSid: publication?.trackSid,
            isSubscribed: publication?.isSubscribed ?? false,
            hasTrack: Boolean(publication?.track),
            trackKind: publication?.track?.kind,
            mediaStreamReadyState: mst?.readyState,
            mediaStreamMuted: mst?.muted,
            mediaStreamEnabled: mst?.enabled,
            mediaStreamId: mst?.id,
          }
        : null,
    });

    if (conn !== ConnectionState.Connected) {
      onState?.("connecting");
      return;
    }

    if (!sellerPresent || !publication) {
      onState?.("buffering");
      return;
    }

    if (publication.isMuted) {
      // Intentionally paused — room is fine, hide the hard buffering overlay.
      onState?.("connected");
      return;
    }

    // Stage D: isSubscribed but no track object → still buffering.
    // The overlay clears via NativeVideo's onPlaying/onMetadata callback,
    // not here — we stay buffering until the <video> actually plays.
    if (subError || !publication.isSubscribed || !publication.track) {
      onState?.("buffering");
      return;
    }

    // Track is subscribed and present — clear the overlay.
    onState?.("connected");
  }, [
    room,
    conn,
    expectedIdentity,
    selected,
    publication,
    remotePub,
    subError,
    needsTap,
    remotes,
    sellerPresent,
    waitReason,
    onState,
  ]);

  // Gate on a real, attachable track. We no longer gate on mediaReady alone
  // because the track object can be attachable before mediaStreamTrack is
  // fully initialized — native attach handles that internally. The key test
  // is: publication.track exists and is attachable.
  const showVideo =
    !!selected &&
    isTrackReference(selected) &&
    !!publication &&
    publication.isSubscribed &&
    !!publication.track &&
    !publication.isMuted;

  return (
    <div className="relative flex-1 min-h-0 h-full w-full overflow-hidden bg-black">
      {showVideo && remoteTrack ? (
        <NativeVideo
          track={remoteTrack}
          trackSid={publication?.trackSid}
          onPlaying={() => {
            logDiag("viewer", { stage: "video_playing" });
            onState?.("connected");
          }}
          onMetadata={(w, h) => {
            logDiag("viewer", {
              stage: "video_metadata",
              videoWidth: w,
              videoHeight: h,
            });
            onState?.("connected");
          }}
          onPlayBlocked={() => setNeedsTap(true)}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center px-4 text-center text-sm text-slate-300">
          {WAIT_COPY[waitReason]}
        </div>
      )}

      {needsTap && showVideo && remoteTrack ? (
        <button
          type="button"
          className="absolute inset-0 z-10 flex items-center justify-center bg-black/40 text-sm font-medium text-white"
          onClick={(e) => {
            const video = (e.currentTarget.parentElement?.querySelector(
              "video",
            ) ?? null) as HTMLVideoElement | null;
            void video?.play().then(
              () => setNeedsTap(false),
              () => {
                /* keep the overlay */
              },
            );
          }}
        >
          Tap to play
        </button>
      ) : null}
    </div>
  );
}

/**
 * Native video renderer using livekit-client's track.attach() directly.
 *
 * The @livekit/components-react <VideoTrack> component was failing to render
 * (Stage E): subscription_succeeded and native_video_attached fired, but the
 * VideoTrack's internal <video> element never received loadedmetadata — the
 * TrackReference wiring was broken. This component bypasses that integration
 * entirely and attaches the RemoteTrack directly to a real, properly-sized
 * <video> element via the documented track.attach() API.
 *
 * track.attach() sets the element's srcObject to the MediaStreamTrack and
 * handles all the RTCRtpReceiver plumbing. We just need to call play().
 */
function NativeVideo({
  track,
  trackSid,
  onPlaying,
  onMetadata,
  onPlayBlocked,
}: {
  track: import("livekit-client").Track;
  trackSid?: string;
  onPlaying?: () => void;
  onMetadata?: (width: number, height: number) => void;
  onPlayBlocked?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;

    logDiag("viewer", { stage: "native_video_attaching", trackSid });

    let attached = false;
    try {
      (track as { attach: (el: HTMLMediaElement) => void }).attach(element);
      attached = true;
      logDiag("viewer", { stage: "native_video_attached", trackSid });
    } catch (e) {
      logDiag("viewer", {
        stage: "native_video_attach_failed",
        trackSid,
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    // Muted so browser autoplay policies don't block play(). Audio is handled
    // separately by RoomAudioRenderer in VideoStage.
    element.muted = true;
    void element
      .play()
      .then(() => {
        logDiag("viewer", { stage: "native_video_playing", trackSid });
        onPlaying?.();
      })
      .catch((error: unknown) => {
        logDiag("viewer", {
          stage: "native_video_play_failed",
          trackSid,
          error: error instanceof Error ? error.message : String(error),
        });
        onPlayBlocked?.();
      });

    return () => {
      if (attached) {
        try {
          (track as { detach: (el: HTMLMediaElement) => void }).detach(element);
        } catch {
          // best-effort cleanup
        }
      }
    };
  }, [track, trackSid, onPlaying, onPlayBlocked]);

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted
      className="h-full w-full object-cover"
      onLoadedMetadata={(e) => {
        const video = e.currentTarget;
        logDiag("viewer", {
          stage: "native_video_metadata",
          trackSid,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          hasSrcObject: Boolean(video.srcObject),
        });
        onMetadata?.(video.videoWidth, video.videoHeight);
      }}
      onCanPlay={() => logDiag("viewer", { stage: "video_can_play", trackSid })}
      onPlaying={() => logDiag("viewer", { stage: "video_playing", trackSid })}
      onError={(e) =>
        logDiag("viewer", {
          stage: "video_element_error",
          trackSid,
          error: String(e),
        })
      }
    />
  );
}

/**
 * Lives inside `<LiveKitRoom>` so it can read the room's live ConnectionState.
 * Forwards transitions up to VideoStage → StreamRoom. Does NOT override the
 * more specific buffering/connected signals from SellerVideo — those win once
 * the room is connected.
 */
function LiveKitStateBridge({
  onLiveKitState,
  role,
}: {
  onLiveKitState?: (s: LiveKitConnState) => void;
  role: "seller" | "viewer";
}) {
  const state = useConnectionState();
  useEffect(() => {
    // SOLE-AUTHORITY RULE: for viewers, SellerVideo owns buffering/connected
    // (it knows the camera-subscription state). This bridge must ONLY report
    // transport-level failure states for viewers — never "connecting" or
    // "buffering" — otherwise the bridge's "connecting" (fired during the WS
    // handshake, before tracks exist) stomps SellerVideo's eventual
    // "connected", and StreamRoom's aggregation maps the stale "connecting"
    // to "buffering" forever ("Buffering… Waiting on the video feed").
    switch (state) {
      case ConnectionState.Disconnected:
        onLiveKitState?.("disconnected");
        break;
      case ConnectionState.Connecting:
        // Seller needs the connecting signal for its local preview flow.
        // Viewer: do NOT report — SellerVideo reports its own connecting.
        if (role === "seller") onLiveKitState?.("connecting");
        break;
      case ConnectionState.Connected:
        if (role === "seller") {
          onLiveKitState?.("connected");
        }
        // Viewer: leave connected/buffering to SellerVideo.
        break;
      case ConnectionState.Reconnecting:
        onLiveKitState?.("reconnecting");
        break;
      case ConnectionState.SignalReconnecting:
        onLiveKitState?.("reconnecting");
        break;
    }
  }, [state, onLiveKitState, role]);
  return null;
}

/**
 * Seller local camera preview. Uses the same NativeVideo renderer as the
 * viewer (track.attach directly) — no VideoTrack/GridLayout needed for a
 * one-seller stream. The local camera track comes from useTracks.
 */
function LocalSellerPreview() {
  const tracks = useTracks(
    [{ source: Track.Source.Camera, withPlaceholder: true }],
    { onlySubscribed: false },
  );
  const local = tracks.find(
    (t) => t.participant.isLocal && isTrackReference(t),
  );

  if (!local || !isTrackReference(local)) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-slate-900 text-sm text-slate-300">
        Starting your camera...
      </div>
    );
  }

  const localTrack = local.publication.track as
    | import("livekit-client").Track
    | undefined;

  if (!localTrack) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-slate-900 text-sm text-slate-300">
        Starting your camera...
      </div>
    );
  }

  return (
    <NativeVideo
      track={localTrack}
      trackSid={local.publication.trackSid}
    />
  );
}

/**
 * One-shot grant diagnostic after mount. Decodes the JWT payload (no verify)
 * and logs the grants without printing the raw token.
 */
function TokenGrantProbe({
  token,
  role,
  roomName,
  sellerId,
}: {
  token: string;
  role: "seller" | "viewer";
  roomName: string;
  sellerId: string;
}) {
  useEffect(() => {
    const payload = decodeJwtPayload(token);
    const video = (payload?.video ?? {}) as Record<string, unknown>;
    logDiag(role, {
      stage: "token_grants",
      identity: payload?.sub ?? payload?.identity,
      expectedIdentity:
        role === "seller" ? `seller-${sellerId}` : "(viewer-*)",
      roomName,
      grantRoom: video.room,
      roomJoin: video.roomJoin,
      canPublish: video.canPublish,
      canSubscribe: video.canSubscribe,
      canPublishSources: video.canPublishSources,
      canPublishData: video.canPublishData,
    });
  }, [token, role, roomName, sellerId]);
  return null;
}

export default function VideoStage({
  token,
  serverUrl,
  role,
  roomName,
  sellerId,
  active,
  onLiveKitState,
}: VideoStageProps) {
  // Seller-only: probe camera/mic permission BEFORE LiveKitRoom tries to
  // publish, so a blocked device surfaces a clear error instead of hanging.
  const [permError, setPermError] = useState<string | null>(null);

  const handleError = useCallback(
    (e: unknown) => {
      console.error("[livekit] room error", e);
      onLiveKitState?.("disconnected");
    },
    [onLiveKitState],
  );

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- deactivation teardown */
    if (role !== "seller" || !active) {
      setPermError(null);
      return;
    }
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ video: true, audio: true })
      .then((stream) => {
        // Stop immediately — LiveKit re-acquires on publish. Probe only.
        stream.getTracks().forEach((t) => t.stop());
        if (!cancelled) {
          logDiag("seller", {
            stage: "permission_probe_ok",
            videoTracks: stream.getVideoTracks().length,
            audioTracks: stream.getAudioTracks().length,
          });
        }
      })
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
        onLiveKitState?.("disconnected");
      });
    return () => {
      cancelled = true;
    };
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [role, active, onLiveKitState]);

  if (role === "seller" && permError) {
    return (
      <div className="flex flex-1 items-center justify-center rounded bg-slate-900 p-4 text-center text-sm text-slate-300">
        {permError}
      </div>
    );
  }

  return (
    <LiveKitRoom
      token={token}
      serverUrl={serverUrl}
      connect={active ?? true}
      // Still pass video/audio so LiveKitRoom pre-creates tracks for sellers.
      // SellerPublisher additionally forces setCameraEnabled/setMicrophoneEnabled
      // after connect so we don't depend on the prop alone.
      video={role === "seller"}
      audio={role === "seller"}
      options={{
        // adaptiveStream off while diagnosing visibility-gated subscription.
        // Single full-screen seller video doesn't benefit from adaptive stream,
        // and it previously created a subscribe-only-if-visible dead end.
        adaptiveStream: false,
        dynacast: true,
      }}
      className="flex h-full flex-col gap-2"
      data-lk-purpose={role}
      onDisconnected={() => onLiveKitState?.("disconnected")}
      onError={handleError}
    >
      <TokenGrantProbe
        token={token}
        role={role}
        roomName={roomName}
        sellerId={sellerId}
      />
      <LiveKitStateBridge onLiveKitState={onLiveKitState} role={role} />
      {role === "seller" ? (
        <>
          <SellerPublisher
            role={role}
            roomName={roomName}
            sellerId={sellerId}
          />
          <LocalSellerPreview />
        </>
      ) : (
        <SellerVideo sellerId={sellerId} onState={onLiveKitState} />
      )}

      {/* Viewers still need to hear the seller. */}
      {role === "viewer" ? <RoomAudioRenderer /> : null}
    </LiveKitRoom>
  );
}
