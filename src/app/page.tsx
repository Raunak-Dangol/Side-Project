import Link from "next/link";
import StreamFeed from "@/components/StreamFeed";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { StreamFeedItem } from "@/lib/types";

// Revalidate frequently instead of forcing fully dynamic rendering. Live streams
// change infrequently (a seller going live), so a 10s cache makes repeat
// navigations / back-button near-instant while keeping the feed fresh enough.
export const revalidate = 10;

/**
 * Root home (`/`) — full-screen, live-only vertical feed (TikTok-style).
 *
 * Lives OUTSIDE the `(shop)` route group on purpose so it uses the root layout
 * alone (no Navbar) and fills the viewport. The old grid homepage moved to
 * `/browse` and keeps the `(shop)` Navbar.
 *
 * Role is NOT derived globally here — a user may own one live stream but only
 * watch the others, so StreamFeed derives `seller` vs `viewer` per stream.
 */
export default async function FeedPage() {
  const supabase = await createSupabaseServerClient();

  // Run auth + the streams query IN PARALLEL. The viewer display_name lookup
  // depends on the user id, so it's a second step — but it runs concurrently
  // with the streams fetch, not sequentially. This cuts the home page from
  // 3-4 serial round-trips down to 2 stages.
  const [authResult, streamsResult] = await Promise.all([
    supabase.auth.getUser(),
    supabase
      .from("streams")
      .select(
        "*, seller:seller_id(id, display_name, is_verified), pinned_product:pinned_product_id(*)",
      )
      .eq("status", "live")
      .order("created_at", { ascending: false }),
  ]);
  const user = authResult.data.user ?? null;
  const streams = (streamsResult.data as StreamFeedItem[] | null) ?? [];

  // Viewer display name only when authenticated. Runs only after we know the
  // id, but is a single round-trip (and skipped for anon).
  let viewerName: string | null = null;
  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("display_name")
      .eq("id", user.id)
      .single();
    viewerName = profile?.display_name ?? null;
  }

  if (streams.length === 0) {
    return (
      <main className="flex h-dvh items-center justify-center bg-black text-center">
        <div>
          <p className="text-white/90 text-lg font-medium">
            No live streams right now
          </p>
          <Link
            href="/browse"
            className="mt-4 inline-block rounded-full bg-white/10 px-5 py-2 text-sm text-white transition hover:bg-white/20"
          >
            Browse other streams
          </Link>
        </div>
      </main>
    );
  }

  return (
    <StreamFeed
      streams={streams}
      viewerId={user?.id ?? null}
      viewerName={viewerName}
    />
  );
}
