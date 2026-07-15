import Link from "next/link";
import StreamFeed from "@/components/StreamFeed";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getAuthenticatedUser } from "@/lib/auth";
import type { StreamFeedItem } from "@/lib/types";

export const dynamic = "force-dynamic";

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
  const user = await getAuthenticatedUser(supabase);

  // Load the viewer's display name only when authenticated. The feed passes it
  // to StreamView for the presence avatar stack + chat attribution.
  let viewerName: string | null = null;
  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("display_name")
      .eq("id", user.id)
      .single();
    viewerName = profile?.display_name ?? null;
  }

  const { data } = await supabase
    .from("streams")
    .select(
      "*, seller:seller_id(id, display_name, is_verified), pinned_product:pinned_product_id(*)",
    )
    .eq("status", "live")
    .order("created_at", { ascending: false });

  const streams = (data as StreamFeedItem[] | null) ?? [];

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
