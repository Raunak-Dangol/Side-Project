import { AccessToken } from "livekit-server-sdk";
import { serverEnv } from "@/lib/env";

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
