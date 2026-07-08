import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const Create = z.object({
  name: z.string().trim().min(1).max(120),
  price_cents: z.number().int().positive(),
  stock: z.number().int().min(0),
  image_url: z.string().url().nullable().optional(),
});

const Update = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(120).optional(),
  price_cents: z.number().int().positive().optional(),
  stock: z.number().int().min(0).optional(),
  image_url: z.string().url().nullable().optional(),
});

/**
 * Create (POST) or update (PATCH) a product. Ownership is enforced by RLS
 * (seller_id must equal auth.uid()), so we set seller_id from the session.
 */
async function requireUser() {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  return { supabase, user };
}

export async function POST(request: NextRequest) {
  let parsed: z.infer<typeof Create>;
  try {
    parsed = Create.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const { supabase, user } = auth;

  const { data, error } = await supabase
    .from("products")
    .insert({
      seller_id: user.id,
      name: parsed.name,
      price_cents: parsed.price_cents,
      stock: parsed.stock,
      image_url: parsed.image_url ?? null,
    })
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json(data);
}

export async function PATCH(request: NextRequest) {
  let parsed: z.infer<typeof Update>;
  try {
    parsed = Update.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const { supabase } = auth;

  const { id, ...patch } = parsed;
  const { data, error } = await supabase
    .from("products")
    .update(patch)
    .eq("id", id) // RLS restricts this to the owning seller
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json(data);
}
