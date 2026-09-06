import { createDb, type DbPair } from "@/db/client";
import { createRepo, type Repo } from "@/db/repos";
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
  const repo = createRepo(db);
  const auditor = createAuditor(repo);

  repo.createCustomer({ id: "CUST-1", name: "Jane", email: "jane@t.com", passwordHash: PW, role: "customer", createdAt: T - 60 * DAY });
  repo.createCustomer({ id: "CUST-2", name: "Alex", email: "alex@t.com", passwordHash: PW, role: "customer", createdAt: T - 60 * DAY });
  repo.createCustomer({ id: "ADMIN-1", name: "Morgan", email: "admin@t.com", passwordHash: PW, role: "admin", createdAt: T - 60 * DAY });
  repo.createCustomer({ id: "SUPP-1", name: "Riley", email: "riley@t.com", passwordHash: PW, role: "support_agent", createdAt: T - 60 * DAY });

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
