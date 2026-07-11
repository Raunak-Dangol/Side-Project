import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { SellerApplication } from "@/lib/types";

const Body = z.object({
  userId: z.string().uuid(),
  businessName: z.string().trim().min(1).max(120),
  contactPhone: z.string().trim().min(1).max(40),
  idVerificationNote: z.string().trim().min(1).max(1000),
});

/**
 * Submits a seller application. Guards (★ pending-specific, mirroring the
 * `one_pending_application_per_user` partial unique index — a rejected history
 * must NOT block reapplication):
 *   - requires auth
 *   - caller's session user must match `userId` in the body
 *   - 409 if the caller is already an approved seller
 *   - 409 if the caller already has a 'pending' application
 *
 * The actual write goes through the SECURITY DEFINER RPC
 * `submit_seller_application`, which inserts the application row AND flips
 * profiles.seller_status = 'pending' in ONE transaction — so the two writes
 * can never partially fail. The RPC re-checks auth.uid() = p_user and lets the
 * unique-pending index raise on a duplicate, which we map to a 409.
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
  // Impersonation guard: the body's userId must match the session user.
  if (user.id !== parsed.userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ★ Pending-specific guard: look at status = 'pending' only, never "any" or
  // "latest" application. A rejected history does not block reapply.
  const { data: existing } = await supabase
    .from("seller_applications")
    .select("id")
    .eq("user_id", user.id)
    .eq("status", "pending")
    .limit(1)
    .maybeSingle();
  if (existing) {
    return NextResponse.json(
      { error: "You already have an application under review." },
      { status: 409 },
    );
  }

  // Atomic insert + profile flip via SECURITY DEFINER RPC.
  const { data: appRow, error } = await supabase.rpc(
    "submit_seller_application",
    {
      p_user: user.id,
      p_business: parsed.businessName,
      p_phone: parsed.contactPhone,
      p_note: parsed.idVerificationNote,
    },
  );

  if (error) {
    // 23505 = unique_violation → a 'pending' row slipped in concurrently.
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "You already have an application under review." },
        { status: 409 },
      );
    }
    // P0001 = the RPC's "already an approved seller" raise.
    if (error.code === "P0001") {
      return NextResponse.json(
        { error: "You are already an approved seller." },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json(appRow as SellerApplication, { status: 201 });
}
