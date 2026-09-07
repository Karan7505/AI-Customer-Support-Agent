"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { fmtCents, fmtDateTime } from "@/lib/client";
import { StatusPill, TICKET_STATUS, TICKET_PRIORITY, ORDER_STATUS } from "@/components/status";

const FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "in_progress", label: "In progress" },
  { key: "resolved", label: "Resolved" },
  { key: "closed", label: "Closed" },
];

const STATUS_OPTIONS = TICKET_STATUS;
const PRIORITY_OPTIONS = TICKET_PRIORITY;

interface Ticket {
  id: string;
  customerId: string;
  orderId: string | null;
  subject: string;
  description: string;
  priority: string;
  status: string;
  internalNotes: { author: string; authorRole: string; content: string; at: number }[];
  customer?: { id: string; name: string; email: string };
  createdAt: number;
  updatedAt: number;
}

interface Detail {
  ticket: Ticket;
  customer: { id: string; name: string; email: string } | null;
  order: any | null;
}

export default function SupportPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<any>(null);
  const [filter, setFilter] = useState("all");
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const q = filter === "all" ? "" : `?status=${filter}`;
      const r = await api<{ tickets: Ticket[] }>(`/api/tickets${q}`);
      setTickets(r.tickets);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    (async () => {
      try {
        const me = await api<{ user: any }>(`/api/auth/me`);
        const u = me.user;
        if (u.role !== "admin" && u.role !== "support_agent") {
          router.replace("/chat");
          return;
        }
        setUser(u);
        await load();
      } catch {
        router.replace("/login");
        return;
      } finally {
        setReady(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ready || !user) return;
    setLoading(true);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const select = useCallback(
    async (id: string) => {
      setSelectedId(id);
      setDetail(null);
      try {
        setDetail(await api<Detail>(`/api/tickets/${id}`));
      } catch {
        /* keep list visible */
      }
    },
    [],
  );

  async function act(id: string, body: Record<string, unknown>, refreshNote = false) {
    setBusy(true);
    try {
      await api(`/api/tickets/${id}`, { method: "POST", body: JSON.stringify(body) });
      if (refreshNote) setNote("");
      await Promise.all([load(), select(id)]);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  if (!ready) return <Center>Loading…</Center>;
  if (!user) return null;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-surface-line bg-surface/70 backdrop-blur sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-accent to-sky-400 grid place-items-center text-white text-sm font-bold">
              A
            </div>
            <div>
              <div className="text-sm font-semibold text-white leading-none">Support Desk</div>
              <div className="text-xs text-slate-400 mt-0.5">
                {user.name} · {user.role.replace("_", " ")}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link2 to="/chat">Chat</Link2>
            {user.role === "admin" && <Link2 to="/admin">Admin</Link2>}
            <button
              className="btn-ghost text-xs"
              onClick={async () => {
                await api("/api/auth/logout", { method: "POST" });
                router.push("/login");
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto w-full px-4 py-4">
        <div className="flex gap-1 rounded-lg bg-white/5 p-1 w-fit" data-testid="support-filters">
          {FILTERS.map((f) => (
            <TabBtn
              key={f.key}
              active={filter === f.key}
              onClick={() => setFilter(f.key)}
              data-testid={`support-filter-${f.key}`}
            >
              {f.label}
            </TabBtn>
          ))}
        </div>
      </div>

      <main className="max-w-6xl mx-auto w-full px-4 pb-8 flex-1">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_1fr] items-start">
          {/* Ticket list */}
          <section className={`card overflow-hidden ${selectedId ? "hidden lg:block" : "block"}`} data-testid="support-tickets-list">
            <div className="px-4 py-2.5 border-b border-surface-line text-xs uppercase tracking-wide text-slate-500">
              {loading ? "Loading…" : `${tickets.length} ticket${tickets.length === 1 ? "" : "s"}`}
            </div>
            <div className="divide-y divide-surface-line max-h-[calc(100dvh-16rem)] overflow-auto">
              {tickets.length === 0 && !loading && (
                <div className="p-6 text-center text-sm text-slate-500">
                  No {filter === "all" ? "" : filter.replace("_", " ")} tickets.
                </div>
              )}
              {tickets.map((t) => (
                <button
                  key={t.id}
                  onClick={() => select(t.id)}
                  className={`w-full text-left px-4 py-3 hover:bg-white/5 transition-colors ${
                    selectedId === t.id ? "bg-white/[0.07]" : ""
                  }`}
                  data-testid={`support-ticket-card-${t.id}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-slate-400">{t.id}</span>
                    <span data-testid={`support-list-status-${t.id}`}>
                      <StatusPill meta={TICKET_STATUS[t.status]} />
                    </span>
                    <span className="ml-auto">
                      <StatusPill meta={TICKET_PRIORITY[t.priority]} />
                    </span>
                  </div>
                  <div className="mt-1 text-sm text-slate-200 truncate" data-testid="support-ticket-subject">
                    {t.subject}
                  </div>
                  <div className="mt-1 flex items-center gap-1 text-xs text-slate-500">
                    <span className="truncate">{t.customer?.name ?? t.customerId}</span>
                    {t.orderId && <span className="font-mono">· {t.orderId}</span>}
                    <span className="ml-auto shrink-0">{fmtDateTime(t.updatedAt)}</span>
                  </div>
                </button>
              ))}
            </div>
          </section>

          {/* Detail pane */}
          <section className={`card p-4 sm:p-5 ${selectedId ? "block" : "hidden lg:block"}`} data-testid="support-detail">
            {!detail ? (
              <div className="text-sm text-slate-500 py-10 text-center">
                {selectedId ? "Loading ticket…" : "Select a ticket to see details and take action."}
              </div>
            ) : (
              <TicketDetail
                d={detail}
                note={note}
                setNote={setNote}
                busy={busy}
                onBack={() => setSelectedId(null)}
                onStatus={(s) => act(detail.ticket.id, { status: s })}
                onPriority={(p) => act(detail.ticket.id, { priority: p })}
                onNote={(n) => act(detail.ticket.id, { note: n }, true)}
              />
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function TicketDetail({
  d,
  note,
  setNote,
  busy,
  onBack,
  onStatus,
  onPriority,
  onNote,
}: {
  d: Detail;
  note: string;
  setNote: (v: string) => void;
  busy: boolean;
  onBack: () => void;
  onStatus: (s: string) => void;
  onPriority: (p: string) => void;
  onNote: (n: string) => void;
}) {
  const { ticket, customer, order } = d;
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <button className="lg:hidden btn-ghost text-xs" onClick={onBack} data-testid="support-back">
          ← Back
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm text-accent">{ticket.id}</span>
            <span data-testid="support-detail-status">
              <StatusPill meta={TICKET_STATUS[ticket.status]} />
            </span>
            <StatusPill meta={TICKET_PRIORITY[ticket.priority]} />
          </div>
          <h2 className="mt-2 text-lg font-semibold text-white">{ticket.subject}</h2>
          <div className="mt-1 text-xs text-slate-500">Opened {fmtDateTime(ticket.createdAt)}</div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-3 rounded-lg bg-white/5 p-3">
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Status
          <select
            className="input py-1.5 min-w-[9rem]"
            key={`st-${ticket.status}`}
            defaultValue={ticket.status}
            onChange={(e) => onStatus(e.target.value)}
            disabled={busy}
            data-testid="support-status-select"
          >
            {Object.entries(STATUS_OPTIONS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Priority
          <select
            className="input py-1.5 min-w-[9rem]"
            key={`pr-${ticket.priority}`}
            defaultValue={ticket.priority}
            onChange={(e) => onPriority(e.target.value)}
            disabled={busy}
            data-testid="support-priority-select"
          >
            {Object.entries(PRIORITY_OPTIONS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
        <form
          className="flex-1 min-w-[14rem] flex gap-2 items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim().length >= 3) onNote(note.trim());
          }}
        >
          <div className="flex-1">
            <input
              className="input"
              placeholder="Add an internal note…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={busy}
              data-testid="support-note-input"
            />
          </div>
          <button
            className="btn-primary"
            type="submit"
            disabled={busy || note.trim().length < 3}
            data-testid="support-note-add"
          >
            Add note
          </button>
        </form>
      </div>

      {/* Customer + order */}
      <div className="grid sm:grid-cols-2 gap-3">
        <InfoCard title="Customer" data-testid="support-customer">
          {customer ? (
            <>
              <div className="text-sm text-slate-200">{customer.name}</div>
              <div className="text-xs text-slate-500">{customer.email}</div>
              <div className="text-xs text-slate-500 font-mono mt-1">{customer.id}</div>
            </>
          ) : (
            <div className="text-sm text-slate-500">Unknown customer</div>
          )}
        </InfoCard>
        <InfoCard title="Linked order" data-testid="support-order">
          {order ? (
            <>
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm text-slate-200">{order.id}</span>
                <StatusPill meta={ORDER_STATUS[order.status]} />
              </div>
              <div className="mt-1 text-sm text-slate-300">{fmtCents(order.total, order.currency)}</div>
            </>
          ) : (
            <div className="text-sm text-slate-500">No order linked</div>
          )}
        </InfoCard>
      </div>

      {/* Description */}
      <div>
        <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">Description</div>
        <p className="text-sm text-slate-200 whitespace-pre-wrap" data-testid="support-description">
          {ticket.description}
        </p>
      </div>

      {/* Internal notes */}
      <div>
        <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">Internal notes</div>
        {ticket.internalNotes?.length ? (
          <ol className="space-y-2" data-testid="support-notes">
            {ticket.internalNotes.map((n, i) => (
              <li key={i} className="rounded-lg bg-white/5 px-3 py-2" data-testid={`support-note-${i}`}>
                <div className="text-xs text-slate-500">
                  {n.author} · {n.authorRole.replace("_", " ")} · {fmtDateTime(n.at)}
                </div>
                <div className="text-sm text-slate-200 mt-0.5 whitespace-pre-wrap">{n.content}</div>
              </li>
            ))}
          </ol>
        ) : (
          <div className="text-sm text-slate-500">No notes yet.</div>
        )}
      </div>
    </div>
  );
}

function InfoCard({ title, children, "data-testid": testid }: { title: string; children: React.ReactNode; "data-testid"?: string }) {
  return (
    <div className="rounded-lg bg-white/5 p-3" data-testid={testid}>
      <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">{title}</div>
      {children}
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
  "data-testid": testid,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  "data-testid"?: string;
}) {
  return (
    <button
      onClick={onClick}
      data-testid={testid}
      className={`px-3 py-1.5 rounded-md text-sm transition-colors ${active ? "bg-accent text-white" : "text-slate-300 hover:bg-white/5"}`}
    >
      {children}
    </button>
  );
}

function Link2({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <a href={to} className="btn-ghost text-xs">
      {children}
    </a>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen grid place-items-center text-slate-400">{children}</div>;
}
