import Link from "next/link";
import { notFound } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { initials } from "@/lib/utils";
import type { FollowListUser } from "@/lib/types";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

/**
 * Lists the users `id` follows (rows where follower_id = id), joined to their
 * profiles. Each row links to that user's own /u/[id] page.
 */
export default async function FollowingPage({ params }: Props) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();

  const [{ data: profile }, { data: rows }] = await Promise.all([
    supabase.from("profiles").select("id, display_name").eq("id", id).single(),
    supabase
      .from("follows")
      .select("followee:followee_id(id, display_name, is_verified)")
      .eq("follower_id", id)
      .order("created_at", { ascending: false }),
  ]);

  if (!profile) notFound();

  const users = ((rows ?? []) as unknown as {
    followee: FollowListUser;
  }[]).map((r) => r.followee);

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-semibold text-slate-900">
        People {profile.display_name ?? "user"} follows
      </h1>
      <p className="text-sm text-slate-500 mb-6">
        Following {users.length}
      </p>

      {users.length === 0 ? (
        <div className="card p-8 text-center text-slate-500">
          Not following anyone yet.
        </div>
      ) : (
        <ul className="card divide-y divide-slate-100 overflow-hidden">
          {users.map((u) => (
            <li key={u.id}>
              <Link
                href={`/u/${u.id}`}
                className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-50">
                  {initials(u.display_name ?? "U")}
                </span>
                <span className="flex items-center gap-1 truncate text-sm font-medium text-slate-800">
                  {u.display_name ?? "User"}
                  {u.is_verified ? (
                    <span className="badge bg-gold/20 text-gold-dark">
                      verified
                    </span>
                  ) : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
