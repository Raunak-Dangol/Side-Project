"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { Profile } from "@/lib/types";

export default function Navbar() {
  const supabase = createSupabaseBrowserClient();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user && mounted) {
        const { data } = await supabase
          .from("profiles")
          .select("*")
          .eq("id", user.id)
          .single();
        if (mounted) setProfile((data as Profile | null) ?? null);
      }
      if (mounted) setLoading(false);
    })();

    let isInitialized = false;
    let lastUserId: string | undefined = undefined;

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      const currentUserId = session?.user?.id;
      if (isInitialized && lastUserId !== currentUserId) {
        window.location.reload();
      }
      lastUserId = currentUserId;
      isInitialized = true;
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, [supabase]);

  async function signOut() {
    await supabase.auth.signOut();
    window.location.href = "/";
  }

  return (
    <header className="bg-primary">
      <div className="mx-auto max-w-6xl px-4 py-3 flex items-center justify-between">
        <Link
          href="/"
          className="flex items-center gap-2 font-semibold text-primary-50"
        >
          <span className="inline-block h-6 w-6 rounded bg-gold" />
          Live Shop
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          <Link
            href="/"
            className="px-3 py-1.5 rounded text-primary-50 hover:bg-primary-dark"
          >
            Streams
          </Link>
          {profile?.seller_status === "approved" ? (
            <>
              <Link
                href="/seller/dashboard"
                className="px-3 py-1.5 rounded text-primary-50 hover:bg-primary-dark"
              >
                Dashboard
              </Link>
              <Link
                href="/seller/orders"
                className="px-3 py-1.5 rounded text-primary-50 hover:bg-primary-dark"
              >
                Orders
              </Link>
            </>
          ) : null}
          {loading ? null : profile ? (
            <>
              {/* TODO (post-prototype): fold this into a proper profile menu. */}
              {profile.seller_status !== "approved" ? (
                <Link
                  href="/seller/apply"
                  className="px-3 py-1.5 rounded text-gold-light hover:bg-primary-dark"
                >
                  Become a seller
                </Link>
              ) : null}
              <span className="px-3 py-1.5 text-primary-50">
                {profile.display_name ?? "User"}
                {profile.role === "admin" ? (
                  <span className="ml-1 badge bg-gold/20 text-gold-light">
                    admin
                  </span>
                ) : null}
              </span>
              <button
                onClick={signOut}
                className="rounded-md border border-primary-50/30 px-3 py-1.5 text-primary-50 transition hover:bg-primary-dark"
              >
                Sign out
              </button>
            </>
          ) : (
            <Link
              href="/login"
              className="rounded-md bg-primary-50 px-3 py-1.5 font-medium text-primary transition hover:bg-white"
            >
              Sign in
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
