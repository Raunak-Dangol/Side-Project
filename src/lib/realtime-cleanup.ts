import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";

/**
 * Graceful Supabase realtime channel removal for React effect cleanups.
 *
 * The default `client.removeChannel(channel)` IS async — it awaits
 * `channel.unsubscribe()`, which sends a leave push over the realtime socket.
 * But React effect cleanups can't be async, so the typical pattern
 * `return () => { supabase.removeChannel(channel); }` doesn't await:
 * the cleanup returns immediately, the next navigation/StrictMode teardown
 * rips the socket down, and the in-flight `unsubscribe()` promise rejects with
 * "Client initiated disconnect" — surfacing in the console as a scary
 * `ConnectionError` even though the teardown is benign.
 *
 * `removeChannelSilently()` awaits the removal and swallows that specific
 * expected rejection (and any "__unused" swallow of the row-locked socket
 * tear-down) so the disconnect path stays log-quiet. Other rejections still
 * propagate.
 *
 * Usage in a cleanup:
 *   return () => { void removeChannelSilently(supabase, channel); };
 */
export async function removeChannelSilently(
  client: SupabaseClient,
  channel: RealtimeChannel | null,
): Promise<void> {
  if (!channel) return;
  try {
    await client.removeChannel(channel);
  } catch (err) {
    // The expected benign failure during teardown. Swallow — there's nothing
    // to recover and no user-facing state to fix; the channel is gone either
    // way. Anything else (e.g. a real socket error before cleanup) we still
    // swallow here because the cleanup is best-effort by definition.
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("Client initiated disconnect") ||
      msg.includes("socket") ||
      msg.includes("closed")
    ) {
      return;
    }
    // Non-teardown error — re-surface so real bugs aren't hidden.
    throw err;
  }
}
