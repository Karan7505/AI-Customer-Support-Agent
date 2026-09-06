"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/client";
import { fmtCents, fmtDateTime } from "@/lib/client";
import { StatusPill, ORDER_STATUS, REFUND_STATUS } from "@/components/status";

type Card = any;
type UIMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  cards?: Card[];
  events?: any[];
};

const SUGGESTIONS = [
  "Where is my order ORD-1001?",
  "Check order ORD-1002",
  "My package arrived damaged. Create a support ticket for this.",
  "Refund my last order",
  "Refund $20 from order ORD-1002",
  "What is your return policy?",
];

const STAFF_SUGGESTIONS = [
  "Who is the customer Jane Doe?",
  "Show all orders for the customer Jane Doe",
  "Check order ORD-2001",
  "List the open tickets",
  "Refund $40 from order ORD-9999 for the customer Alex Kim",
  "What is your return policy?",
];

export default function ChatPage() {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  const [status, setStatus] = useState<any>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (async () => {
      // Resolve the authenticated user. On failure, /api/auth/me returns 401
      // and we redirect to login; on success we keep rendering.
      let me: any = null;
      try {
        const r = await api<{ user: any }>("/api/auth/me");
        me = r.user;
        setUser(me);
      } catch {
        router.replace("/login");
        return;
      }
      try {
        const h = await api<{ messages: any[] }>("/api/chat/history");
        setMessages(
          h.messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m, i) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              cards: m.meta?.cards ?? [],
              events: m.meta?.events ?? [],
            })),
        );
      } catch {
        /* ignore */
      }
      refreshStatus();
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshStatus() {
    try {
      setStatus(await api("/api/status"));
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy, activity]);

  async function send(text?: string) {
    const msg = (text ?? input).trim();
    if (!msg || busy) return;
    setInput("");
    setBusy(true);
    setActivity("Checking your request…");
    setMessages((m) => [...m, { id: Date.now(), role: "user", content: msg }]);
    try {
      const res = await api<{ assistant: string; cards: any[]; events: any[]; structured: any }>(
        "/api/chat",
        { method: "POST", body: JSON.stringify({ message: msg }) },
      );
      setMessages((m) => [
        ...m,
        {
          id: Date.now() + 1,
          role: "assistant",
          content: res.assistant,
          cards: res.cards ?? [],
          events: res.events ?? [],
        },
      ]);
      await refreshStatus();
    } catch (e) {
      setMessages((m) => [
        ...m,
        { id: Date.now() + 1, role: "assistant", content: `Something went wrong: ${e instanceof Error ? e.message : "error"}` },
      ]);
    } finally {
      setBusy(false);
      setActivity(null);
    }
  }

  // All roles can chat; staff get a staff-aware toolset server-side.
  const canChat = !!user;
  const isStaff = !!user && (user.role === "admin" || user.role === "support_agent");

  if (loading) {
    return (
      <div className="min-h-screen grid place-items-center text-slate-400">
        <div className="flex items-center gap-2">
          <Spinner /> Loading…
        </div>
      </div>
    );
  }

  if (!canChat) return null;

  return (
    <div className="h-[100dvh] flex flex-col">
      <Header user={user} onLogout={async () => { await api("/api/auth/logout", { method: "POST" }); router.push("/login"); }} />

      {status?.awaitingApproval && (
        <div className="bg-amber-500/10 border-b border-amber-500/20 text-amber-200 text-sm px-4 py-2 flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
          You have a refund waiting for approval. Nothing has been refunded yet — check back after it is approved.
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto" data-testid="chat-messages">
        <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
          {messages.length === 0 && (
            <EmptyState onSuggest={send} isStaff={isStaff} />
          )}
          {messages.map((m) => (
            <MessageBubble key={m.id} m={m} />
          ))}
          {busy && (
            <div className="flex items-center gap-2 text-slate-400 text-sm">
              <Spinner /> {activity ?? "Working…"}
            </div>
          )}
        </div>
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); send(); }}
        className="border-t border-surface-line bg-surface/60 backdrop-blur"
      >
        <div className="max-w-3xl mx-auto px-4 py-3 flex gap-2">
          <input
            className="input flex-1"
            placeholder={
              isStaff
                ? "Search a customer, check any order or ticket, file a ticket, or start a refund…"
                : "Ask about your order, request a refund, or create a ticket…"
            }
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={!canChat || busy}
            data-testid="chat-input"
          />
          <button className="btn-primary" type="submit" disabled={!canChat || busy || !input.trim()} data-testid="chat-send">
            Send
          </button>
        </div>
      </form>
    </div>
  );
}

function Header({ user, onLogout }: { user: any; onLogout: () => void }) {
  return (
    <header className="border-b border-surface-line bg-surface/70 backdrop-blur">
      <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-accent to-sky-400 grid place-items-center text-white text-sm font-bold">A</div>
          <div>
            <div className="text-sm font-semibold text-white leading-none">Aurora Support</div>
            <div className="text-xs text-slate-400 mt-0.5">{user.name} · {user.role.replace("_", " ")}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {user.role === "admin" && <Link href="/admin" className="btn-ghost text-xs">Admin</Link>}
          <button className="btn-ghost text-xs" onClick={onLogout}>Sign out</button>
        </div>
      </div>
    </header>
  );
}

function EmptyState({ onSuggest, isStaff }: { onSuggest: (s: string) => void; isStaff?: boolean }) {
  const suggestions = isStaff ? STAFF_SUGGESTIONS : SUGGESTIONS;
  return (
    <div className="text-center py-10">
      <div className="mx-auto h-12 w-12 rounded-2xl bg-gradient-to-br from-accent to-sky-400 grid place-items-center text-white font-bold text-xl mb-3">A</div>
      <h2 className="text-lg font-semibold text-white">Hi, how can I help?</h2>
      <p className="text-sm text-slate-400 mt-1 max-w-md mx-auto">
        {isStaff
          ? "I can look up any customer, their orders and tickets, file or update tickets, and initiate refunds (with approval)."
          : "I can check your orders and tracking, open support tickets, and process refunds (with approval)."}
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {suggestions.map((s) => (
          <button key={s} onClick={() => onSuggest(s)} className="chip bg-white/5 ring-1 ring-surface-line text-slate-300 hover:bg-white/10">
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ m }: { m: UIMessage }) {
  const isUser = m.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[85%] space-y-2 ${isUser ? "items-end" : "items-start"}`}>
        <div
          className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${
            isUser
              ? "bg-accent text-white rounded-br-md"
              : "bg-surface-card border border-surface-line text-slate-200 rounded-bl-md"
          }`}
        >
          <p className="whitespace-pre-wrap">{m.content}</p>
        </div>
        {/* tool activity strip (read-only) */}
        {!isUser && m.events && m.events.length > 0 && (
          <ToolTrace events={m.events} />
        )}
        {!isUser &&
          (m.cards ?? []).map((c, i) => <CardView key={i} card={c} />)}
      </div>
    </div>
  );
}

function ToolTrace({ events }: { events: any[] }) {
  const calls = events.filter((e) => e.type === "tool_call");
  if (!calls.length) return null;
  return (
    <div className="text-xs text-slate-500 flex flex-wrap gap-1">
      {calls.map((c, i) => (
        <span key={i} className="chip bg-white/5 ring-1 ring-surface-line text-slate-400">
          ⚙ {c.toolName}
        </span>
      ))}
    </div>
  );
}

function CardView({ card }: { card: Card }) {
  if (card.kind === "order") return <OrderCard order={card.order} tracking={card.tracking} />;
  if (card.kind === "ticket") return <TicketCard ticket={card.ticket} />;
  if (card.kind === "refund" || card.kind === "approval") return <RefundCard card={card} />;
  return null;
}

function OrderCard({ order, tracking }: { order: any; tracking?: any }) {
  const meta = ORDER_STATUS[order.status];
  return (
    <div className="card p-4 w-full max-w-sm" data-testid="order-card">
      <div className="flex items-center justify-between">
        <span className="font-mono text-sm text-slate-300">{order.id}</span>
        <StatusPill meta={meta} />
      </div>
      <div className="mt-2 text-lg font-semibold text-white">
        {fmtCents(order.total, order.currency)}
      </div>
      <ul className="mt-2 space-y-1 text-sm text-slate-400">
        {order.items?.map((it: any, i: number) => (
          <li key={i}>
            {it.name} <span className="text-slate-500">×{it.qty}</span>
          </li>
        ))}
      </ul>
      {tracking && (
        <div className="mt-3 pt-3 border-t border-surface-line">
          <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">Tracking</div>
          <ol className="space-y-2">
            {tracking.events?.map((ev: any, i: number) => (
              <li key={i} className="flex gap-2 text-sm">
                <span className={`mt-1 h-2 w-2 rounded-full shrink-0 ${i === tracking.events.length - 1 ? "bg-accent" : "bg-slate-600"}`} />
                <div>
                  <div className="text-slate-300">{ev.description}</div>
                  <div className="text-xs text-slate-500">{ev.location} · {fmtDateTime(ev.at)}</div>
                </div>
              </li>
            ))}
          </ol>
          {tracking.eta && (
            <div className="mt-2 text-xs text-emerald-300">ETA {tracking.eta}</div>
          )}
        </div>
      )}
    </div>
  );
}

function TicketCard({ ticket }: { ticket: any }) {
  return (
    <div className="card p-4 w-full max-w-sm">
      <div className="flex items-center justify-between">
        <span className="font-mono text-sm text-slate-300">{ticket.id}</span>
        <StatusPill meta={{ label: `Priority: ${ticket.priority}`, tone: ticket.priority === "high" ? "danger" : "info" }} />
      </div>
      <div className="mt-2 text-sm font-medium text-white">{ticket.subject}</div>
      <div className="mt-1 text-xs text-slate-500">Opened {fmtDateTime(ticket.createdAt)}</div>
      <div className="mt-2 text-xs text-emerald-300 flex items-center gap-1">✓ Ticket created</div>
    </div>
  );
}

function RefundCard({ card }: { card: any }) {
  const meta = REFUND_STATUS[card.status] ?? { label: card.status, tone: "neutral" as const };
  const accent =
    card.status === "completed" ? "text-emerald-300" :
    card.status === "rejected" || card.status === "failed" ? "text-rose-300" :
    "text-amber-300";
  return (
    <div className="card p-4 w-full max-w-sm" data-testid={`refund-card-${card.status}`}>
      <div className="flex items-center justify-between">
        <span className="text-sm text-slate-300">Refund · {card.orderId}</span>
        <StatusPill meta={meta} />
      </div>
      <div className="mt-2 text-xl font-semibold text-white">{fmtCents(card.amount, card.currency)}</div>
      {card.customerName && (
        <div className="mt-1 text-xs text-slate-400">Customer: {card.customerName}</div>
      )}
      {card.approvalId && (
        <div className="mt-2 text-xs text-slate-400">
          Approval request <span className="font-mono text-accent">{card.approvalId}</span>
        </div>
      )}
      <div className={`mt-2 text-xs ${accent}`}>{card.message}</div>
    </div>
  );
}

function Spinner() {
  return (
    <span className="inline-block h-4 w-4 rounded-full border-2 border-slate-500 border-t-accent animate-spin" />
  );
}
