import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const PostBody = z.object({
  blockedId: z.string().uuid(),
});

const DeleteQuery = z.object({
  blockedId: z.string().uuid(),
});

/**
 * Viewer-side block / unblock (P2-E). A viewer's personal block list drives
 * chat filtering on their own stream view — blocked users' messages don't
 * render for the blocker. This is NOT a global mute; the blocked user can still
 * post, they're just hidden from the blocker.
 *
 * POST   { blockedId }  -> insert a block row (blocker_id = auth.uid()).
 *   A duplicate block (already blocked) is a 23505 PK violation → 200 no-op.
 * DELETE ?blockedId=     -> delete the block row (idempotent; 200 even if not blocked).
 * GET                   -> the current user's block list (ids only, for chat filtering).
 *
 * All mutations go through the user's session, so RLS (blocks_insert_own /
 * blocks_delete_own / blocks_select_own) gates them to rows where
 * blocker_id = auth.uid(). The API always uses user.id as blocker_id.
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

  // Disallow self-block at the API boundary (the table also CHECKs this).
  if (parsed.blockedId === user.id) {
    return NextResponse.json(
      { error: "You cannot block yourself" },
      { status: 422 },
    );
  }

  const { error } = await supabase
    .from("blocks")
    .insert({ blocker_id: user.id, blocked_id: parsed.blockedId });

  if (error) {
    // 23505 = unique violation (composite PK) — already blocked.
    if (error.code === "23505") {
      return NextResponse.json({ ok: true, alreadyBlocked: true });
    }
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, blocked: true });
}

export async function DELETE(request: NextRequest) {
  const parsed = DeleteQuery.safeParse({
    blockedId: request.nextUrl.searchParams.get("blockedId"),
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const { blockedId } = parsed.data;

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Idempotent: even if the row doesn't exist, RLS-scoped delete is a no-op.
  const { error } = await supabase
    .from("blocks")
    .delete()
    .eq("blocker_id", user.id)
    .eq("blocked_id", blockedId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, blocked: false });
}

export async function GET() {
  // Returns the viewer's own block list (blocked ids only) for chat filtering.
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("blocks")
    .select("blocked_id")
    .eq("blocker_id", user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({
    blockedIds: (data ?? []).map((row) => row.blocked_id),
  });
}
