"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import Navbar from "@/components/Navbar";

export default function LoginPage() {
  const supabase = createSupabaseBrowserClient();
  const router = useRouter();
  const search = useSearchParams();
  const redirect = search.get("redirect") ?? "/";

  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<"google" | "magic" | null>(null);

  async function signInWithGoogle() {
    setError(null);
    setLoading("google");
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(redirect)}`,
      },
    });
    if (error) {
      setError(error.message);
      setLoading(null);
    }
    // On success the browser is redirected to Google; no further action here.
  }

  async function signInWithMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email.trim()) {
      setError("Enter your email.");
      return;
    }
    setLoading("magic");
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(redirect)}`,
      },
    });
    setLoading(null);
    if (error) {
      setError(error.message);
      return;
    }
    setSent(true);
  }

  return (
    <>
      <Navbar />
      <div className="mx-auto max-w-sm px-4 py-12">
        <div className="card p-6">
          <h1 className="text-xl font-semibold mb-1">Sign in to Live Shop</h1>
          <p className="text-sm text-slate-500 mb-6">
            Watch live streams, chat, and buy instantly.
          </p>

          <button
            onClick={signInWithGoogle}
            disabled={loading !== null}
            className="btn-secondary w-full"
          >
            {loading === "google" ? "Redirecting…" : "Continue with Google"}
          </button>

          <div className="flex items-center gap-3 my-5">
            <div className="h-px bg-slate-200 flex-1" />
            <span className="text-xs text-slate-400">or</span>
            <div className="h-px bg-slate-200 flex-1" />
          </div>

          {sent ? (
            <div className="rounded-md bg-emerald-50 border border-emerald-200 p-3 text-sm text-emerald-800">
              Check <strong>{email}</strong> for a sign-in link.
            </div>
          ) : (
            <form onSubmit={signInWithMagicLink} className="space-y-3">
              <input
                type="email"
                className="input"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <button
                type="submit"
                className="btn-primary w-full"
                disabled={loading !== null}
              >
                {loading === "magic" ? "Sending…" : "Send magic link"}
              </button>
            </form>
          )}

          {error ? (
            <p className="mt-4 text-sm text-rose-600">{error}</p>
          ) : null}
        </div>

        <p className="text-center text-xs text-slate-400 mt-4">
          Want to sell? Sign in, then{" "}
          <button
            className="underline"
            onClick={() => router.push("/seller/apply")}
          >
            apply to become a seller
          </button>
          .
        </p>
      </div>
    </>
  );
}
