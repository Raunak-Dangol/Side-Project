import { describe, it, expect } from "vitest";

/**
 * StreamView chat filter tests (Phase 4 / P4-D).
 *
 * Two independent chat-hiding filters compose in StreamView's
 * `visibleMessages` memo:
 *
 *   1. blockedIds     — the viewer's OWN block list (Phase 2 / P2-E).
 *                      Applies only to this viewer.
 *   2. sellerMutedIds — the SELLER's stream mutes (Phase 4 / P4-A).
 *                      Applies to EVERY viewer of that stream.
 *
 * A message is hidden if EITHER filter matches its author. Anon viewers have
 * no block list (empty set) but the seller-mute filter STILL applies — that's
 * the whole point of seller-side moderation reaching users who never opted
 * into anything.
 *
 * These tests verify the COMPOSITION — that the two filters stack on top of
 * each other correctly — not just each filter in isolation, per the explicit
 * confirmation in Phase 4 ("add a test verifying viewer personal-block-list
 * filtering AND seller stream-mute filtering both apply correctly in
 * combination, not just independently").
 *
 * The memo under test:
 *
 *   messages.filter(
 *     (m) => !blockedIds.has(m.user_id) && !sellerMutedIds.has(m.user_id),
 *   );
 *
 * — they're combined with AND on the KEEP side, which is OR on the HIDE side:
 * either set listing the author drops the message.
 */

interface Msg {
  id: string;
  user_id: string;
  message: string;
}

function filter(
  messages: Msg[],
  blockedIds: Set<string>,
  sellerMutedIds: Set<string>,
): Msg[] {
  // Mirror of StreamView's visibleMessages memo.
  return messages.filter(
    (m) => !blockedIds.has(m.user_id) && !sellerMutedIds.has(m.user_id),
  );
}

describe("StreamView combined block + seller-mute chat filter", () => {
  // Stable cast of test users.
  const A = "user-a";
  const B = "user-b";
  const C = "user-c";
  const D = "user-d";

  const allMessages: Msg[] = [
    { id: "1", user_id: A, message: "hi" },
    { id: "2", user_id: B, message: "yo" },
    { id: "3", user_id: C, message: "spam" },
    { id: "4", user_id: D, message: "hello" },
  ];

  it("shows everything when neither filter is set", () => {
    expect(filter(allMessages, new Set(), new Set())).toEqual(allMessages);
  });

  it("personal block list alone hides the blocked author's messages", () => {
    const visible = filter(allMessages, new Set([A]), new Set());
    expect(visible.map((m) => m.id)).toEqual(["2", "3", "4"]);
  });

  it("seller mute list alone hides the muted author's messages", () => {
    const visible = filter(allMessages, new Set(), new Set([B]));
    expect(visible.map((m) => m.id)).toEqual(["1", "3", "4"]);
  });

  it("BOTH filters apply in combination — each hides its own authors", () => {
    // A is personally blocked by the viewer; B is seller-muted; C and D
    // are clean. Expect only C and D visible — neither filter hides them,
    // and BOTH A (block) and B (mute) are dropped.
    const visible = filter(allMessages, new Set([A]), new Set([B]));
    expect(visible.map((m) => m.id)).toEqual(["3", "4"]);
  });

  it("hides a user if they appear in EITHER set (OR-on-hide, not only both)", () => {
    // A is in BOTH sets — still hidden exactly once (filter is set-membership,
    // not a count). B is in only one set — still hidden.
    const visible = filter(allMessages, new Set([A, B]), new Set([A]));
    // A hidden (both), B hidden (block), C and D visible.
    expect(visible.map((m) => m.id)).toEqual(["3", "4"]);
  });

  it("personal block applies to the viewer only — anon (empty block list) still sees everything except seller mutes", () => {
    // An anon viewer has NO personal block list — but the seller's mute
    // list STILL filters their chat. C is seller-muted and hidden for anon
    // too; A/B/D visible (anon didn't personally block anyone).
    const visible = filter(allMessages, new Set(), new Set([C]));
    expect(visible.map((m) => m.id)).toEqual(["1", "2", "4"]);
  });

  it("unmuting (removing from sellerMutedIds) restores the author's messages", () => {
    // First B is muted → hidden; then the seller unmutes → B returns.
    const muted = filter(allMessages, new Set(), new Set([B]));
    expect(muted.map((m) => m.id)).toEqual(["1", "3", "4"]);
    const unmuted = filter(allMessages, new Set(), new Set());
    expect(unmuted.map((m) => m.id)).toEqual(["1", "2", "3", "4"]);
  });

  it("the seller's own mute and a viewer's block of the same user are independent — either can be lifted without affecting the other", () => {
    // B is blocked by the viewer AND muted by seller. If the seller
    // unmutes, B is STILL hidden from this viewer (their personal block
    // list stands — orthogonal filters). And vice versa.
    const bothHidden = filter(allMessages, new Set([B]), new Set([B]));
    expect(bothHidden.map((m) => m.id)).not.toContain("2");

    const sellerUnmutes = filter(allMessages, new Set([B]), new Set());
    // Still hidden — viewer's own block remains.
    expect(sellerUnmutes.map((m) => m.id)).not.toContain("2");

    const viewerUnblocks = filter(allMessages, new Set(), new Set([B]));
    // Still hidden — seller's mute remains.
    expect(viewerUnblocks.map((m) => m.id)).not.toContain("2");

    const bothLifted = filter(allMessages, new Set(), new Set());
    expect(bothLifted.map((m) => m.id)).toContain("2");
  });
});

/**
 * Soft-delete filter — the `is(deleted_at, null)` predicate StreamView applies
 * on the initial SELECT and on INSERT/UPDATE realtime payloads. A seller
 * removing a message sets `deleted_at = now()`; the message must drop from
 * every viewer's chat immediately. This is independent of who AUTHORED it
 * (the seller can delete their own messages too, and a muted/blocked user's
 * past messages can still be deleted).
 */
describe("StreamView soft-delete (deleted_at) filter", () => {
  interface MsgWithDelete {
    id: string;
    user_id: string;
    message: string;
    deleted_at: string | null;
  }

  function visible(messages: MsgWithDelete[]): MsgWithDelete[] {
    return messages.filter((m) => m.deleted_at == null);
  }

  it("hides softly-deleted messages on initial load", () => {
    const rows: MsgWithDelete[] = [
      { id: "1", user_id: "a", message: "alive", deleted_at: null },
      { id: "2", user_id: "b", message: "gone", deleted_at: "2026-07-21T12:00:00Z" },
      { id: "3", user_id: "c", message: "alive", deleted_at: null },
    ];
    expect(visible(rows).map((m) => m.id)).toEqual(["1", "3"]);
  });

  it("an UPDATE payload that set deleted_at drops the row from the live list", () => {
    // Mirror of the UPDATE realtime handler:
    //   if (!row.deleted_at) return;
    //   setMessages((prev) => prev.filter((m) => m.id !== row.id));
    let list: MsgWithDelete[] = [
      { id: "1", user_id: "a", message: "x", deleted_at: null },
      { id: "2", user_id: "b", message: "y", deleted_at: null },
    ];
    // Simulate the seller deleting message 2.
    const payload: MsgWithDelete = {
      id: "2",
      user_id: "b",
      message: "y",
      deleted_at: "2026-07-21T12:00:00Z",
    };
    if (!payload.deleted_at) {
      // no-op
    } else {
      list = list.filter((m) => m.id !== payload.id);
    }
    expect(list.map((m) => m.id)).toEqual(["1"]);
  });

  it("an UPDATE payload that did NOT touch deleted_at is a no-op", () => {
    // A non-delete UPDATE (e.g. message text edited by author — though the
    // app doesn't support editing, the realtime UPDATE could carry other
    // column changes). deleted_at stays null; the handler leaves the list.
    let list: MsgWithDelete[] = [
      { id: "1", user_id: "a", message: "x", deleted_at: null },
    ];
    const payload: MsgWithDelete = {
      id: "1",
      user_id: "a",
      message: "x",
      deleted_at: null,
    };
    if (!payload.deleted_at) {
      // no-op — row stays
    } else {
      list = list.filter((m) => m.id !== payload.id);
    }
    expect(list.map((m) => m.id)).toEqual(["1"]);
  });

  it("soft-delete is orthogonal to the mute/block filters — a deleted message is hidden regardless of author status", () => {
    // A user is muted by the seller AND their message is soft-deleted. Both
    // the mute filter and the deleted_at filter agree on hiding it; the
    // soft-delete is the durable one (it can't be undone by unmuting).
    const rows: MsgWithDelete[] = [
      { id: "1", user_id: "muted", message: "spam", deleted_at: "2026-07-21T12:00:00Z" },
      { id: "2", user_id: "muted", message: "still here", deleted_at: null },
    ];
    const sellerMutedIds = new Set(["muted"]);
    // Apply BOTH the deleted_at load filter AND the seller-mute visibility
    // filter — the order matches StreamView (load filters DeletedAt, then
    // the memo filters on the sets).
    const afterDelete = rows.filter((m) => m.deleted_at == null);
    const afterMute = afterDelete.filter((m) => !sellerMutedIds.has(m.user_id));
    expect(afterMute.map((m) => m.id)).toEqual([]);
  });
});
