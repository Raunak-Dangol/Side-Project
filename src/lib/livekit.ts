import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { serverEnv } from "@/lib/env/server";
import { publicEnv } from "@/lib/env";

/**
 * Server-side LiveKit access token generation. NEVER call this from client code
 * — the API secret is required and must never reach the browser.
 *
 * Seller tokens can publish audio/video; viewer tokens can only subscribe.
 */
export async function generateLiveKitToken(params: {
  roomName: string;
  participantIdentity: string;
  participantName?: string;
  canPublish: boolean;
}): Promise<string> {
  const apiKey = serverEnv.livekitApiKey;
  const apiSecret = serverEnv.livekitApiSecret;

  const at = new AccessToken(apiKey, apiSecret, {
    identity: params.participantIdentity,
    name: params.participantName,
    // Short-lived: 2 hours is plenty for a prototype stream.
    ttl: 60 * 60 * 2,
  });
  at.addGrant({
    room: params.roomName,
    roomJoin: true,
    canPublish: params.canPublish,
    canSubscribe: true,
    canPublishData: false,
    canUpdateOwnMetadata: false,
  });

  return at.toJwt();
}

/**
 * Derive the RoomServiceClient host (https://) from the public wss:// URL.
 * The RoomServiceClient speaks the LiveKit HTTP/twirp API, which uses the
 * same host as the realtime URL but over http(s) instead of ws(s).
 *
 * Returns null when no LiveKit URL is configured (prototype envs without
 * LiveKit wired up — ban-kick is then a no-op the caller can tolerate).
 */
function livekitHttpHost(): string | null {
  const wsUrl = publicEnv.livekitUrl;
  if (!wsUrl) return null;
  // wss://host → https://host ; ws://host → http://host
  return wsUrl.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
}

/**
 * Kicks a participant from a LiveKit room NOW (Phase 4 / P4-C). Used by the
 * ban route AFTER the `stream_bans` row is committed, so a racing reconnect
 * is already refused at token issuance by the time this kick lands — closing
 * the reconnect-timing gap.
 *
 * Best-effort: the ban is already enforced server-side at token issuance, so
 * a failed kick (participant already left, transient LiveKit error) does NOT
 * roll back the ban — the user stays banned. We just swallow the error and
 * return; the caller doesn't need to act on a kick failure.
 */
export async function banUser(roomName: string, identity: string): Promise<void> {
  const host = livekitHttpHost();
  if (!host) return; // no LiveKit configured — ban is enforced at token only
  try {
    const client = new RoomServiceClient(
      host,
      serverEnv.livekitApiKey,
      serverEnv.livekitApiSecret,
    );
    await client.removeParticipant(roomName, identity);
  } catch {
    // Best-effort. The token-issuance ban check is the authoritative gate;
    // this kick is just to drop the user immediately instead of waiting for
    // their token to expire. A failure here is safe to ignore.
  }
}

