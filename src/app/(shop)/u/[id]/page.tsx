import Link from "next/link";
import { notFound } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { initials } from "@/lib/utils";
import FollowButton from "@/components/FollowButton";
import type { Profile, StreamFeedItem } from "@/lib/types";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

/**
 * Public profile page for any user (seller or buyer) at /u/[id].
 *
 * Shows the user's display name, follower/following counts (computed at read
 * time via count queries — no denormalized counters), a Follow/Unfollow button
 * (hidden on the viewer's own profile), and their streams (most recent first,
 * matching the seller dashboard's idiom). Followers/following counts link to
 * dedicated list pages.
 *
 * All reads go through the anon client: `follows_select_all` is public, so
 * follower/following counts work even for logged-out viewers.
 */
export default async function ProfilePage({ params }: Props) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();

  const userResult = await supabase.auth.getUser();
  const viewerId = userResult.data.user?.id ?? null;

  // (1) profile, (2) follower count, (3) following count, (4) is_following
  // (only when authenticated), (5) their streams. These all run in parallel.
  const isFollowingPromise = viewerId
    ? supabase
        .from("follows")
        .select("*", { count: "exact", head: true })
        .eq("follower_id", viewerId)
        .eq("followee_id", id)
    : Promise.resolve(null);

  const [profileRes, followerRes, followingRes, isFollowingRes, streamsRes] =
    await Promise.all([
      supabase.from("profiles").select("*").eq("id", id).single(),
      supabase
        .from("follows")
        .select("*", { count: "exact", head: true })
        .eq("followee_id", id),
      supabase
        .from("follows")
        .select("*", { count: "exact", head: true })
        .eq("follower_id", id),
      isFollowingPromise,
      supabase
        .from("streams")
        .select(
          "*, seller:seller_id(id, display_name, is_verified), pinned_product:pinned_product_id(*)",
        )
        .eq("seller_id", id)
        .order("created_at", { ascending: false }),
    ]);

  if (profileRes.error || !profileRes.data) {
    notFound();
  }
  const profile = profileRes.data as Profile;

  const followerCount = followerRes.count ?? 0;
  const followingCount = followingRes.count ?? 0;
  const isFollowing = (isFollowingRes?.count ?? 0) > 0;
  const streams = (streamsRes.data as StreamFeedItem[] | null) ?? [];

  const isOwnProfile = viewerId === profile.id;

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <div className="card p-6">
        <div className="flex items-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary text-xl font-semibold text-primary-50">
            {initials(profile.display_name ?? "U")}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-xl font-semibold text-slate-900">
                {profile.display_name ?? "User"}
              </h1>
              {profile.is_verified ? (
                <span className="badge bg-gold/20 text-gold-dark">verified</span>
              ) : null}
              {profile.role === "admin" ? (
                <span className="badge bg-slate-100 text-slate-600">admin</span>
              ) : null}
            </div>
            <div className="mt-2 flex items-center gap-4 text-sm text-slate-600">
              <Link
                href={`/u/${profile.id}/followers`}
                className="hover:text-gold-dark hover:underline"
              >
                <span className="font-semibold text-slate-900">
                  {followerCount}
                </span>{" "}
                followers
              </Link>
              <Link
                href={`/u/${profile.id}/following`}
                className="hover:text-gold-dark hover:underline"
              >
                <span className="font-semibold text-slate-900">
                  {followingCount}
                </span>{" "}
                following
              </Link>
            </div>
          </div>

          {!isOwnProfile ? (
            <FollowButton
              targetId={profile.id}
              initiallyFollowing={isFollowing}
              disabled={!viewerId}
            />
          ) : null}
        </div>
        {!viewerId && !isOwnProfile ? (
          <p className="mt-4 text-xs text-slate-500">
            <Link href="/login" className="text-gold-dark underline">
              Sign in
            </Link>{" "}
            to follow {profile.display_name ?? "this user"}.
          </p>
        ) : null}
      </div>

      <section className="mt-8">
        <h2 className="mb-3 text-lg font-semibold text-slate-900">
          Streams ({streams.length})
        </h2>
        {streams.length === 0 ? (
          <div className="card p-8 text-center text-slate-500">
            No streams yet.
          </div>
        ) : (
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {streams.map((s) => (
              <li key={s.id} className="list-none">
                <Link
                  href={`/stream/${s.id}`}
                  className="card block overflow-hidden hover:shadow-md transition"
                >
                  <div className="aspect-video bg-slate-900 relative">
                    {s.status === "live" ? (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <span className="flex h-3 w-3 mr-2">
                          <span className="absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75 animate-ping" />
                          <span className="relative inline-flex h-3 w-3 rounded-full bg-rose-500" />
                        </span>
                        <span className="text-white font-medium">LIVE</span>
                      </div>
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center text-white/70 text-xs">
                        Stream ended
                      </div>
                    )}
                  </div>
                  <div className="p-3">
                    <h3 className="font-medium text-slate-900 truncate">
                      {s.title}
                    </h3>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
