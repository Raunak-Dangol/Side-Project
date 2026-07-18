import { describe, it, expect, vi } from "vitest";
import { removeChannelSilently } from "./realtime-cleanup";
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";

// The helper's contract: await the channel's removal, swallow the benign
// "Client initiated disconnect" (the log noise we're fixing), re-throw anything
// that indicates a real bug.

function makeClient(throwOnRemove: unknown): SupabaseClient {
  return {
    removeChannel: vi.fn(async () => {
      if (throwOnRemove instanceof Error) throw throwOnRemove;
      return throwOnRemove;
    }),
  } as unknown as SupabaseClient;
}

const fakeChannel = {} as RealtimeChannel;

describe("removeChannelSilently", () => {
  it("no-ops on a null channel without touching the client", async () => {
    const client = makeClient(undefined);
    await removeChannelSilently(client, null);
    expect(client.removeChannel).not.toHaveBeenCalled();
  });

  it("awaits removeChannel on a real channel", async () => {
    const client = makeClient(undefined);
    await removeChannelSilently(client, fakeChannel);
    expect(client.removeChannel).toHaveBeenCalledWith(fakeChannel);
  });

  it("swallows the 'Client initiated disconnect' teardown error", async () => {
    const client = makeClient(new Error("Client initiated disconnect"));
    await expect(removeChannelSilently(client, fakeChannel)).resolves.toBeUndefined();
  });

  it("swallows socket-closed teardown errors", async () => {
    const client = makeClient(new Error("socket closed"));
    await expect(removeChannelSilently(client, fakeChannel)).resolves.toBeUndefined();
  });

  it("re-throws non-teardown errors so real bugs aren't hidden", async () => {
    const realBug = new Error("something genuinely broke");
    const client = makeClient(realBug);
    await expect(removeChannelSilently(client, fakeChannel)).rejects.toThrow(
      "something genuinely broke",
    );
  });
});
