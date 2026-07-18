import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { rateLimit, getClientId } from "@/lib/rate-limit";

const Body = z.object({
  reportedId: z.string().uuid(),
  streamId: z.string().uuid(),
  // Free-text reason, capped to keep rows bounded. The UI sends a short label
  // or a trimmed note; we don't enforce a fixed enum so the prototype can grow
  // categories later without a migration.
  reason: z.string().trim().min(1).max(500),
  messageId: z.string().uuid().nullable().optional(),
});

/**
 * Submit a user report (P2-E). A viewer flags another user (optionally tied to
 * a specific chat message) for admin review. Reports are write-only from the
 * client's perspective — they INSERT their own and can SELECT their own
 * submissions; admins read all via the service-role client (RLS bypass).
 *
 * Rate-limited per user (10/min) and per IP (20/min). Reports are inherently
 * low-volume, but without a cap a script could flood the admin queue. The
 * per-user limit is the binding constraint.
 *
 * RLS (reports_insert_own) guarantees reporter_id = auth.uid(); the API always
 * uses user.id, so a client can never file a report under another user's id.
 */
export async function POST(request: NextRequest) {
  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await request.json());
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

  // Disallow self-report at the API boundary (the table also CHECKs this).
  if (parsed.reportedId === user.id) {
    return NextResponse.json(
      { error: "You cannot report yourself" },
      { status: 422 },
    );
  }

  // Rate limit: 10 reports/min per user (binding), 20/min per IP.
  const ipLimit = await rateLimit({
    key: `report:ip:${getClientId(request)}`,
    limit: 20,
  });
  if (!ipLimit.ok) {
    return NextResponse.json(
      { error: "Too many reports. Slow down." },
      { status: 429 },
    );
  }
  const userLimit = await rateLimit({
    key: `report:user:${user.id}`,
    limit: 10,
  });
  if (!userLimit.ok) {
    return NextResponse.json(
      { error: "You're reporting too fast." },
      { status: 429 },
    );
  }

  const { error } = await supabase.from("reports").insert({
    reporter_id: user.id,
    reported_id: parsed.reportedId,
    stream_id: parsed.streamId,
    reason: parsed.reason,
    message_id: parsed.messageId ?? null,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
