"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { escapeForRender } from "@/lib/sanitize";
import { timeAgo } from "@/lib/utils";
import type { ChatMessageWithUser } from "@/lib/types";

export default function ChatPanel({ streamId }: { streamId: string }) {
  const supabase = createSupabaseBrowserClient();
  const [messages, setMessages] = useState<ChatMessageWithUser[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Initial load + realtime subscription.
  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;

    (async () => {
      const { data, error } = await supabase
        .from("chat_messages")
        .select("*, profiles:profiles!user_id(id, display_name)")
        .eq("stream_id", streamId)
        .order("created_at", { ascending: true })
        .limit(100);
      if (error) {
        setError(error.message);
      } else if (data) {
        setMessages(data as ChatMessageWithUser[]);
      }

      channel = supabase
        .channel(`chat:${streamId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "chat_messages",
            filter: `stream_id=eq.${streamId}`,
          },
          async (payload) => {
            // Fetch the joined profile for the new row.
            const newRow = payload.new as ChatMessageWithUser;
            const { data: profileRow } = await supabase
              .from("profiles")
              .select("id, display_name")
              .eq("id", newRow.user_id)
              .single();
            setMessages((prev) => [
              ...prev,
              { ...newRow, profiles: profileRow ?? null },
            ]);
          },
        )
        .subscribe();
    })();

    return () => {
      if (channel) supabase.removeChannel(channel);
    };
  }, [supabase, streamId]);

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setError(null);

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setError("Please sign in to chat.");
      return;
    }

    startTransition(async () => {
      // POST through the API route for Zod validation + rate limiting + sanitization.
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ streamId, message: text }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Failed to send message");
        return;
      }
      setDraft("");
    });
  }

  return (
    <div className="flex flex-col h-full card">
      <div className="px-3 py-2 border-b border-slate-200 text-sm font-medium">
        Live chat
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-1.5 text-sm">
        {messages.length === 0 ? (
          <p className="text-slate-400 text-xs">No messages yet. Say hi 👋</p>
        ) : null}
        {messages.map((m) => (
          <div key={m.id} className="leading-snug">
            <span className="font-medium text-brand-700">
              {m.profiles?.display_name ?? "Someone"}
            </span>{" "}
            <span className="text-slate-400 text-[10px]">{timeAgo(m.created_at)}</span>
            <div
              className="text-slate-700"
              // We escape on store AND on render; render with dangerouslySetInnerHTML
              // is intentionally avoided — React already escapes text children.
            >
              {escapeForRender(m.message)}
            </div>
          </div>
        ))}
      </div>
      <form onSubmit={send} className="p-2 border-t border-slate-200 flex gap-2">
        <input
          className="input"
          placeholder="Type a message…"
          value={draft}
          maxLength={500}
          onChange={(e) => setDraft(e.target.value)}
          disabled={pending}
        />
        <button type="submit" className="btn-primary" disabled={pending || !draft.trim()}>
          Send
        </button>
      </form>
      {error ? (
        <p className="px-3 pb-2 text-xs text-rose-600">{error}</p>
      ) : null}
    </div>
  );
}
