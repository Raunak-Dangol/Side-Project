import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { sanitizeText } from "@/lib/sanitize";
import { rateLimit, getClientId } from "@/lib/rate-limit";

const Body = z.object({
  streamId: z.string().uuid(),
  message: z.string().trim().min(1).max(500),
});

/**
 * Stores a chat message. Input is Zod-validated, rate-limited (in-memory for
 * the prototype), and sanitized before insert. RLS also enforces user_id =
 * auth.uid() on the row.
 */
export async function POST(request: NextRequest) {
  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to chat" }, { status: 401 });
  }

  // Rate limit: 20 messages / minute per user, 30 / min per IP.
  // TODO (post-prototype): move to Upstash Redis.
  const ipLimit = rateLimit({ key: `chat:ip:${getClientId(request)}`, limit: 30 });
  if (!ipLimit.ok) {
    return NextResponse.json(
      { error: "Too many messages. Slow down." },
      { status: 429 },
    );
  }
  const userLimit = rateLimit({ key: `chat:user:${user.id}`, limit: 20 });
  if (!userLimit.ok) {
    return NextResponse.json(
      { error: "You're sending messages too fast." },
      { status: 429 },
    );
  }

  const clean = sanitizeText(parsed.message, 500);
  if (!clean) {
    return NextResponse.json({ error: "Empty message" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("chat_messages")
    .insert({
      stream_id: parsed.streamId,
      user_id: user.id,
      message: clean,
    })
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json(data);
}
