import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const PostBody = z.object({
  followeeId: z.string().uuid(),
});

const DeleteQuery = z.object({
  followeeId: z.string().uuid(),
});

/**
 * Follow / unfollow a user.
 *
 * POST { followeeId }  -> insert a follow row (follower_id = auth.uid()).
 *   A duplicate insert (already following) returns 200 { ok: true, alreadyFollowing: true }
 *   so the client can treat it as a successful no-op.
 * DELETE ?followeeId=  -> delete the follow row (idempotent; 200 even if not following).
 *
 * Both mutations go through the user's session, so RLS (follows_insert_own /
 * follows_delete_own) gates them to rows where follower_id = auth.uid().
 */
export async function POST(request: NextRequest) {
  let parsed: z.infer<typeof PostBody>;
  try {
    parsed = PostBody.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Disallow self-follow at the API boundary.
  if (parsed.followeeId === user.id) {
    return NextResponse.json(
      { error: "You cannot follow yourself" },
      { status: 422 },
    );
  }

  const { error } = await supabase
    .from("follows")
    .insert({ follower_id: user.id, followee_id: parsed.followeeId });

  if (error) {
    // 23505 = unique violation (composite PK) — already following.
    if (error.code === "23505") {
      return NextResponse.json({ ok: true, alreadyFollowing: true });
    }
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, following: true });
}

export async function DELETE(request: NextRequest) {
  const parsed = DeleteQuery.safeParse({
    followeeId: request.nextUrl.searchParams.get("followeeId"),
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const { followeeId } = parsed.data;

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Idempotent: even if the row doesn't exist, RLS-scoped delete is a no-op.
  const { error } = await supabase
    .from("follows")
    .delete()
    .eq("follower_id", user.id)
    .eq("followee_id", followeeId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, following: false });
}
