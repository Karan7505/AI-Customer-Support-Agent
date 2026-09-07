"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/client";

const DEMO_ACCOUNTS = [
  { label: "Customer", email: "jane@example.com", note: "Jane — 3 orders, one refundable" },
  { label: "Customer 2", email: "alex@example.com", note: "Alex — owner of ORD-9999" },
  { label: "Support", email: "riley@support.example.com", note: "Riley — views tickets & requests" },
  { label: "Admin", email: "admin@example.com", note: "Morgan — approves refunds & audit" },
];

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("jane@example.com");
  const [password, setPassword] = useState("demo1234");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function doLogin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ user: { role: string } }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      router.push(res.user.role === "admin" ? "/admin" : res.user.role === "support_agent" ? "/support" : "/chat");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  function quick(acc: (typeof DEMO_ACCOUNTS)[number]) {
    setEmail(acc.email);
    setPassword("demo1234");
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-4xl grid md:grid-cols-2 gap-6">
        {/* Brand */}
        <div className="hidden md:flex flex-col justify-center px-6">
          <div className="flex items-center gap-2 mb-6">
            <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-accent to-sky-400 grid place-items-center text-white font-bold">
              A
            </div>
            <span className="text-lg font-semibold text-white">Aurora Support</span>
          </div>
          <h1 className="text-3xl font-semibold text-white leading-snug">
            An AI support agent that can <span className="text-accent">do</span>, not just talk.
          </h1>
          <ul className="mt-6 space-y-2 text-sm text-slate-400">
            <li>• Real tool calls: orders, tracking, tickets, refunds</li>
            <li>• Deterministic permissions & risk policy</li>
            <li>• Human approval before any money moves</li>
            <li>• Full audit trail & idempotent refunds</li>
          </ul>
        </div>

        {/* Form */}
        <div className="card p-6 md:p-8">
          <h2 className="text-xl font-semibold text-white">Sign in</h2>
          <p className="text-sm text-slate-400 mt-1">
            Demo password for every account: <code className="font-mono text-accent">demo1234</code>
          </p>
          <form onSubmit={doLogin} className="mt-6 space-y-4">
            <div>
              <label className="text-sm text-slate-300">Email</label>
              <input
                className="input mt-1"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="off"
                data-testid="login-email"
              />
            </div>
            <div>
              <label className="text-sm text-slate-300">Password</label>
              <input
                className="input mt-1"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
                data-testid="login-password"
              />
            </div>
            {error && (
              <div className="text-sm text-rose-300 bg-rose-500/10 ring-1 ring-rose-500/30 rounded-lg px-3 py-2">
                {error}
              </div>
            )}
            <button className="btn-primary w-full" disabled={busy} data-testid="login-submit">
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>

          <div className="mt-6">
            <p className="text-xs uppercase tracking-wide text-slate-500 mb-2">Quick demo logins</p>
            <div className="grid grid-cols-2 gap-2">
              {DEMO_ACCOUNTS.map((acc) => (
                <button
                  key={acc.email}
                  onClick={() => quick(acc)}
                  className="text-left rounded-lg border border-surface-line bg-white/5 hover:bg-white/10 px-3 py-2 transition-colors"
                >
                  <div className="text-sm font-medium text-slate-100">{acc.label}</div>
                  <div className="text-xs text-slate-400 truncate">{acc.email}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="mt-6 text-xs text-slate-500">
            <Link href="/" className="hover:text-slate-300">
              ← Home
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
