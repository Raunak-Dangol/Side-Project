import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { sanitizeText } from "@/lib/sanitize";
import { rateLimit, getClientId } from "@/lib/rate-limit";

const Body = z.object({
  streamId: z.string().uuid(),
  message: z.string().trim().min(1).max(500),
});

/**
 * Stores a chat message. Input is Zod-validated, rate-limited (Upstash Redis
 * when configured, in-memory otherwise), and sanitized before insert. Messages
 * persist to the `chat_messages` table (RLS enforces user_id = auth.uid()).
 */
export async function POST(request: NextRequest) {
  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const user = await getAuthenticatedUser(supabase);
  if (!user) {
    return NextResponse.json({ error: "Sign in to chat" }, { status: 401 });
  }

  // Rate limit: 20 messages / minute per user, 30 / min per IP.
  // Uses Upstash Redis when configured, else an in-memory limiter.
  const ipLimit = await rateLimit({
    key: `chat:ip:${getClientId(request)}`,
    limit: 30,
  });
  if (!ipLimit.ok) {
    return NextResponse.json(
      { error: "Too many messages. Slow down." },
      { status: 429 },
    );
  }
  const userLimit = await rateLimit({
    key: `chat:user:${user.id}`,
    limit: 20,
  });
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
