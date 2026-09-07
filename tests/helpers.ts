import { createDb, type DbPair } from "@/db/client";
import { createSqliteRepo, type Repo } from "@/db/repos";
import { createAuditor } from "@/lib/audit";
import { hashPassword } from "@/lib/security";
import { nowMs } from "@/lib/util";
import type { Principal } from "@/lib/types";

export interface TestEnv extends DbPair {
  repo: Repo;
  auditor: ReturnType<typeof createAuditor>;
  now: number;
}

export const T = nowMs();
export const DAY = 24 * 60 * 60 * 1000;
const PW = hashPassword("demo1234");

export function principal(id: string, role: Principal["role"] = "customer"): Principal {
  return { id, name: `User ${id}`, email: `${id.toLowerCase()}@t.com`, role };
}

export function makePrincipal(role: Principal["role"], id = "ADMIN-1"): Principal {
  return principal(id, role);
}

/** Build a fresh in-memory environment with the standard fixture set. */
export function makeEnv(): TestEnv {
  const { db, raw } = createDb(":memory:");
  const repo = createSqliteRepo(db);
  const auditor = createAuditor(repo);

  // Seed principals via the raw (synchronous) handle so makeEnv stays sync.
  const insCust = (id: string, name: string, email: string, role: string) =>
    raw.prepare("INSERT INTO customers (id, name, email, password_hash, role, created_at) VALUES (?,?,?,?,?,?)").run(id, name, email, PW, role, T - 60 * DAY);
  insCust("CUST-1", "Jane", "jane@t.com", "customer");
  insCust("CUST-2", "Alex", "alex@t.com", "customer");
  insCust("ADMIN-1", "Morgan", "admin@t.com", "admin");
  insCust("SUPP-1", "Riley", "riley@t.com", "support_agent");

  insertOrder(raw, {
    id: "ORD-1", customerId: "CUST-1", status: "delivered", total: 12000, currency: "USD",
    items: [{ name: "Desk Mat", qty: 1, priceCents: 12000 }],
    address: { line1: "1 Loop", city: "SF", state: "CA", postalCode: "94107", country: "US" },
    trackingNumber: "TRK-1", createdAt: T - 3 * DAY, deliveredAt: T - 1 * DAY, refundableAmount: 12000,
  });
  insertOrder(raw, {
    id: "ORD-2", customerId: "CUST-1", status: "shipped", total: 8999, currency: "USD",
    items: [{ name: "Keyboard", qty: 1, priceCents: 8999 }],
    address: { line1: "1 Loop", city: "SF", state: "CA", postalCode: "94107", country: "US" },
    trackingNumber: "TRK-2", createdAt: T - 6 * DAY, deliveredAt: null, refundableAmount: 0,
  });
  insertOrder(raw, {
    id: "ORD-9999", customerId: "CUST-2", status: "delivered", total: 2500, currency: "USD",
    items: [{ name: "Cable", qty: 1, priceCents: 2500 }],
    address: { line1: "2 Loop", city: "Oak", state: "CA", postalCode: "94601", country: "US" },
    trackingNumber: "TRK-9999", createdAt: T - 2 * DAY, deliveredAt: T - 1 * DAY, refundableAmount: 0,
  });

  return { db, raw, repo, auditor, now: T };
}

export function hashPasswordOf(pw: string) {
  return hashPassword(pw);
}

export function insertOrder(raw: any, o: any) {
  raw.prepare(
    "INSERT INTO orders (id, customer_id, status, total, currency, items, shipping_address, tracking_number, created_at, delivered_at, refundable_amount) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    o.id, o.customerId, o.status, o.total, o.currency,
    JSON.stringify(o.items), JSON.stringify(o.address), o.trackingNumber,
    o.createdAt, o.deliveredAt, o.refundableAmount,
  );
}
