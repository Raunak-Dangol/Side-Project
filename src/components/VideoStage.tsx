"use client";

import {
  LiveKitRoom,
  VideoTrack,
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
  const allTracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    {
      onlySubscribed: false,
      updateOnlyOn: [
        RoomEvent.TrackPublished,
        RoomEvent.TrackUnpublished,
        RoomEvent.TrackSubscribed,
        RoomEvent.TrackUnsubscribed,
        RoomEvent.TrackMuted,
        RoomEvent.TrackUnmuted,
        RoomEvent.ParticipantConnected,
        RoomEvent.ParticipantDisconnected,
        RoomEvent.ConnectionStateChanged,
      ],
    },
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

  const waitReason: ViewerWaitReason = useMemo(() => {
    if (!sellerPresent) return "seller_absent";
    if (!publication) return "waiting_camera";
    if (publication.isMuted) return "camera_muted";
    if (subError) return "subscribe_failed";
    if (!publication.isSubscribed || !publication.track) return "loading";
    if (needsTap) return "tap_to_play";
    // Ready — showVideo will render the element; this value is unused then.
    return "loading";
  }, [sellerPresent, publication, subError, needsTap]);

  // Explicit subscription — do not rely solely on VideoTrack.manageSubscription.
  useEffect(() => {
    if (!remotePub) return;
    if (remotePub.isSubscribed) return;
    try {
      logDiag("viewer", {
        stage: "subscription_requested",
        identity: expectedIdentity,
        trackSid: remotePub.trackSid,
        source: remotePub.source,
      });
      remotePub.setSubscribed(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // External-system error → UI state. Catch path of a Room API call.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSubError(msg);
      console.error("[livekit:viewer] setSubscribed failed", e);
      logDiag("viewer", {
        stage: "subscription_failed",
        error: msg,
        trackSid: remotePub.trackSid,
      });
    }
  }, [remotePub, expectedIdentity]);

  // Diagnostics + parent overlay state. Wait reason itself is derived above.
  useEffect(() => {
    logDiag("viewer", {
      stage: "track_scan",
      connectionState: conn,
      expectedIdentity,
      remoteIdentities: remotes.map((r) => r.identity),
      remotes,
      waitReason,
      selected: selected
        ? {
            identity: selected.participant.identity,
            source: selected.source,
            isTrackRef: isTrackReference(selected),
            isSubscribed: publication?.isSubscribed ?? false,
            isMuted: publication?.isMuted ?? false,
            hasTrack: !!publication?.track,
            trackSid: publication?.trackSid,
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
    subError,
    needsTap,
    remotes,
    sellerPresent,
    waitReason,
    onState,
  ]);

  const showVideo =
    !!selected &&
    isTrackReference(selected) &&
    !!publication &&
    publication.isSubscribed &&
    !!publication.track &&
    !publication.isMuted;

  return (
    <div className="relative flex-1 min-h-0 h-full w-full overflow-hidden bg-black">
      {showVideo ? (
        <VideoTrack
          trackRef={selected}
          // manageSubscription is a backup; we already call setSubscribed above.
          manageSubscription
          onSubscriptionStatusChanged={(subscribed) => {
            logDiag("viewer", {
              stage: subscribed ? "subscription_succeeded" : "subscription_lost",
              trackSid: publication?.trackSid,
            });
            if (!subscribed) setSubError(null);
          }}
          onLoadedMetadata={(e) => {
            const el = e.currentTarget;
            logDiag("viewer", {
              stage: "video_metadata",
              videoWidth: el.videoWidth,
              videoHeight: el.videoHeight,
            });
            // Best-effort autoplay; browsers may still require a gesture.
            void el.play().then(
              () => setNeedsTap(false),
              (err: unknown) => {
                console.warn("[livekit:viewer] video play blocked", err);
                setNeedsTap(true);
              },
            );
          }}
          playsInline
          autoPlay
          muted={false}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center px-4 text-center text-sm text-slate-300">
          {WAIT_COPY[waitReason]}
        </div>
      )}

      {needsTap && showVideo ? (
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
    // For viewers, SellerVideo owns the buffering/connected signal once the
    // room is up. The bridge only reports transport-level states so we don't
    // stomp "buffering" with a premature "connected".
    switch (state) {
      case ConnectionState.Disconnected:
        onLiveKitState?.("disconnected");
        break;
      case ConnectionState.Connecting:
        onLiveKitState?.("connecting");
        break;
      case ConnectionState.Connected:
        if (role === "seller") {
          // Seller has local video via LocalPreview; room connected = good.
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
 * Seller local camera preview. VideoConference pulls in a multi-participant
 * grid + ControlBar we don't need for a one-seller stream; a single VideoTrack
 * of the local camera is enough and avoids GridLayout/updatePages entirely.
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
        Starting your camera…
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-hidden bg-black">
      <VideoTrack
        trackRef={local}
        // Local tracks don't need subscription management.
        playsInline
        autoPlay
        muted // avoid feedback; RoomAudioRenderer isn't used for sellers
        className="h-full w-full object-cover"
      />
    </div>
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
