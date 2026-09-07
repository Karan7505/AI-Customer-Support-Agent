"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { fmtCents, fmtDateTime } from "@/lib/client";
import { StatusPill, APPROVAL_STATUS, RISK_META } from "@/components/status";

export default function AdminPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [approvals, setApprovals] = useState<any[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const [filter, setFilter] = useState<"pending_approval" | "all">("pending_approval");
  const [tab, setTab] = useState<"approvals" | "audit">("approvals");
  const [user, setUser] = useState<any>(null);

  const load = useCallback(async () => {
    try {
      const me = await api<{ user: any }>("/api/auth/me");
      setUser(me.user);
      if (me.user.role !== "admin") {
        router.replace("/chat");
        return;
      }
      const [ap, au] = await Promise.all([
        api<{ approvals: any[] }>(`/api/approvals?status=${filter}`),
        api<{ entries: any[] }>("/api/audit?limit=200"),
      ]);
      setApprovals(ap.approvals);
      setAudit(au.entries);
    } catch (e) {
      if (e instanceof Error && /Sign in|role/.test(e.message)) router.replace("/login");
    } finally {
      setReady(true);
    }
  }, [filter, router]);

  useEffect(() => {
    load();
  }, [load]);

  async function decide(id: string, approve: boolean, reason?: string) {
    const prev = approvals;
    try {
      await api(`/api/approvals/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ approve, reason }),
      });
      await load();
    } catch (e) {
      setApprovals(prev);
      alert(e instanceof Error ? e.message : "Decision failed");
    }
  }

  if (!ready) return <Center>Loading…</Center>;
  if (!user) return null;

  return (
    <div className="min-h-screen">
      <header className="border-b border-surface-line bg-surface/70 backdrop-blur sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-accent to-sky-400 grid place-items-center text-white text-sm font-bold">A</div>
            <div>
              <div className="text-sm font-semibold text-white leading-none">Admin Console</div>
              <div className="text-xs text-slate-400 mt-0.5">{user.name} · {user.role}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link2 to="/support">Support</Link2>
            <Link2 to="/chat">Chat</Link2>
            <button className="btn-ghost text-xs" onClick={async () => { await api("/api/auth/logout", { method: "POST" }); router.push("/login"); }}>
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex gap-1 rounded-lg bg-white/5 p-1">
            <TabBtn active={tab === "approvals"} onClick={() => setTab("approvals")}>Approvals</TabBtn>
            <TabBtn active={tab === "audit"} onClick={() => setTab("audit")}>Audit log</TabBtn>
          </div>
          {tab === "approvals" && (
            <div className="flex gap-1 rounded-lg bg-white/5 p-1">
              <TabBtn active={filter === "pending_approval"} onClick={() => setFilter("pending_approval")}>Pending</TabBtn>
              <TabBtn active={filter === "all"} onClick={() => setFilter("all")}>All</TabBtn>
            </div>
          )}
        </div>

        {tab === "approvals" ? (
          approvals.length === 0 ? (
            <Empty>
              No {filter === "all" ? "" : "pending "}approval requests.
            </Empty>
          ) : (
            <div className="grid gap-3">
              {approvals.map((a) => (
                <ApprovalCard key={a.id} a={a} onDecide={decide} />
              ))}
            </div>
          )
        ) : (
          <AuditTable entries={audit} />
        )}
      </main>
    </div>
  );
}

function ApprovalCard({ a, onDecide }: { a: any; onDecide: (id: string, approve: boolean, reason?: string) => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const risk = RISK_META[a.riskLevel];
  const meta = APPROVAL_STATUS[a.status];
  const isPending = a.status === "pending_approval";

  return (
    <div className="card p-4" data-testid={`approval-${a.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm text-accent">{a.id}</span>
            <StatusPill meta={meta} />
            <StatusPill meta={risk} />
            <span className="text-xs text-slate-500">{fmtDateTime(a.createdAt)}</span>
          </div>
          <div className="mt-2 text-sm text-slate-200">
            <span className="text-slate-400">Action:</span> {a.actionType} · <span className="font-mono text-xs text-slate-400">{a.toolName}</span>
          </div>
          <div className="mt-1 text-sm text-slate-300">
            <span className="text-slate-400">Requested by:</span> {a.requestedByName} ({a.requestedByEmail})
          </div>
          <div className="mt-1 text-sm text-slate-300">
            <span className="text-slate-400">Order:</span> {a.orderId ?? "—"}
            {a.order && <span className="text-slate-500"> · {a.order.status} · refundable {fmtCents(a.order.refundableAmount, a.order.currency)}</span>}
          </div>
          {a.amountCents != null && (
            <div className="mt-1 text-sm text-slate-300">
              <span className="text-slate-400">Amount:</span> {fmtCents(a.amountCents, a.order?.currency ?? "USD")}
            </div>
          )}
          <div className="mt-1 text-sm text-slate-300">
            <span className="text-slate-400">Reason:</span> {(a.arguments as any)?.reason ?? "—"}
          </div>
          {a.status === "rejected" && a.rejectionReason && (
            <div className="mt-1 text-sm text-rose-300">Rejected: {a.rejectionReason}</div>
          )}
          {a.approvedBy && (
            <div className="mt-1 text-xs text-emerald-300">Approved by {a.approvedByName} at {a.resolvedAt ? fmtDateTime(a.resolvedAt) : "—"}</div>
          )}
        </div>

        <div className="shrink-0 flex flex-col items-end gap-2">
          {isPending && (
            <div className="flex gap-2">
              <button className="btn-primary" onClick={() => onDecide(a.id, true)} data-testid="approve-btn">Approve</button>
              <button className="btn-ghost" onClick={() => setRejecting((v) => !v)} data-testid="reject-btn">Reject</button>
            </div>
          )}
          {isPending && rejecting && (
            <div className="flex gap-2 w-64">
              <input className="input" placeholder="Rejection reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
              <button
                className="btn-danger"
                onClick={() => { onDecide(a.id, false, reason || undefined); setRejecting(false); setReason(""); }}
              >
                Confirm
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AuditTable({ entries }: { entries: any[] }) {
  return (
    <div className="card overflow-hidden">
      <div className="max-h-[70vh] overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-surface-card text-slate-400 text-xs uppercase">
            <tr>
              <Th>Time</Th><Th>Actor</Th><Th>Action</Th><Th>Tool</Th><Th>Result</Th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-t border-surface-line align-top">
                <Td>{fmtDateTime(e.timestamp)}</Td>
                <Td>
                  <div className="text-slate-200">{e.actorId}</div>
                  <div className="text-xs text-slate-500">{e.actorRole}</div>
                </Td>
                <Td className="text-slate-200">{e.action}</Td>
                <Td className="font-mono text-xs text-slate-400">{e.toolName ?? "—"}</Td>
                <Td>
                  <pre className="text-xs text-slate-400 whitespace-pre-wrap max-w-xs">
                    {e.result ? JSON.stringify(e.result) : "—"}
                  </pre>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const Th = ({ children }: { children: React.ReactNode }) => (
  <th className="text-left font-medium px-3 py-2">{children}</th>
);
const Td = ({ children, className = "" }: { children: React.ReactNode; className?: string }) => (
  <td className={`px-3 py-2 text-slate-300 ${className}`}>{children}</td>
);

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-md text-sm transition-colors ${active ? "bg-accent text-white" : "text-slate-300 hover:bg-white/5"}`}
    >
      {children}
    </button>
  );
}
function Link2({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <a href={to} className="btn-ghost text-xs">{children}</a>
  );
}
function Center({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen grid place-items-center text-slate-400">{children}</div>;
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="card p-8 text-center text-slate-400 text-sm">{children}</div>;
}
