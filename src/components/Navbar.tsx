"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { initials } from "@/lib/utils";
import type { Profile } from "@/lib/types";

export default function Navbar() {
  const supabase = createSupabaseBrowserClient();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);

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
            <div className="flex items-center gap-1">
              {profile.seller_status !== "approved" ? (
                <Link
                  href="/seller/apply"
                  className="px-3 py-1.5 rounded text-gold-light hover:bg-primary-dark"
                >
                  Become a seller
                </Link>
              ) : null}

              <div className="relative">
                <button
                  onClick={() => setMenuOpen((v) => !v)}
                  className="flex items-center gap-2 rounded-full px-2 py-1 text-primary-50 hover:bg-primary-dark"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                >
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-gold/20 text-xs font-semibold text-gold-light">
                    {initials(profile.display_name ?? "U")}
                  </span>
                  <span className="max-w-[8rem] truncate">
                    {profile.display_name ?? "User"}
                  </span>
                  {profile.role === "admin" ? (
                    <span className="badge bg-gold/20 text-gold-light">
                      admin
                    </span>
                  ) : null}
                </button>

                {menuOpen ? (
                  <>
                    <div
                      className="fixed inset-0 z-10"
                      onClick={() => setMenuOpen(false)}
                      aria-hidden="true"
                    />
                    <div
                      role="menu"
                      className="absolute right-0 z-20 mt-2 w-48 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-lg"
                    >
                      <Link
                        href={`/u/${profile.id}`}
                        role="menuitem"
                        onClick={() => setMenuOpen(false)}
                        className="block px-4 py-2 text-slate-700 hover:bg-slate-50"
                      >
                        Profile
                      </Link>
                      <Link
                        href="/orders"
                        role="menuitem"
                        onClick={() => setMenuOpen(false)}
                        className="block px-4 py-2 text-slate-700 hover:bg-slate-50"
                      >
                        My orders
                      </Link>
                      {profile.seller_status !== "approved" ? (
                        <Link
                          href="/seller/apply"
                          role="menuitem"
                          onClick={() => setMenuOpen(false)}
                          className="block px-4 py-2 text-slate-700 hover:bg-slate-50"
                        >
                          Become a seller
                        </Link>
                      ) : null}
                      <button
                        onClick={signOut}
                        role="menuitem"
                        className="block w-full px-4 py-2 text-left text-rose-600 hover:bg-slate-50"
                      >
                        Sign out
                      </button>
                    </div>
                  </>
                ) : null}
              </div>
            </div>
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
