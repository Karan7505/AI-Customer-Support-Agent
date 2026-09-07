import { describe, it, expect } from "vitest";
import { runTool } from "@/lib/tools";
import { makeEnv, principal } from "../helpers";

const ctx = (env: ReturnType<typeof makeEnv>, id = "CUST-1") => ({
  repo: env.repo,
  auditor: env.auditor,
  principal: principal(id, "customer"),
  conversationId: null,
});

describe("Support ticket creation (integration)", () => {
  it("persists a ticket and returns its id", async () => {
    const env = makeEnv();
    const res = await runTool(ctx(env), "create_support_ticket", {
      orderId: "ORD-1",
      subject: "Arrived damaged",
      description: "The desk mat arrived with a cracked corner.",
      priority: "high",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const t = (res.data as any).ticket;
      expect(t.id).toMatch(/^TCK-/);
      const stored = await env.repo.getTicket(t.id);
      expect(stored).toBeTruthy();
      expect(stored?.customerId).toBe("CUST-1");
      expect(stored?.orderId).toBe("ORD-1");
      expect(stored?.priority).toBe("high");
    }
  });

  it("rejects a ticket referencing another customer's order", async () => {
    const env = makeEnv();
    const res = await runTool(ctx(env, "CUST-1"), "create_support_ticket", {
      orderId: "ORD-9999",
      subject: "About a different order",
      description: "This references someone else's order.",
      priority: "low",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("NOT_FOUND");
  });

  it("rejects an invalid priority", async () => {
    const env = makeEnv();
    const res = await runTool(ctx(env), "create_support_ticket", {
      subject: "hi there",
      description: "a real description",
      priority: "asap",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("VALIDATION_ERROR");
  });

  it("a new ticket has an empty internal-notes thread", async () => {
    const env = makeEnv();
    const res = await runTool(ctx(env), "create_support_ticket", {
      subject: "New issue",
      description: "Something to report.",
      priority: "medium",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as any).ticket.internalNotes).toEqual([]);
  });

  it("staff can append a note and it is returned on the ticket", async () => {
    const env = makeEnv();
    const staffCtx = { repo: env.repo, auditor: env.auditor, principal: principal("SUPP-1", "support_agent"), conversationId: null };
    const created = await runTool(ctx(env), "create_support_ticket", {
      subject: "Damaged item",
      description: "The mat arrived cracked.",
      priority: "high",
    });
    const id = (created.ok ? (created.data as any).ticket.id : "") as string;
    expect(id).toMatch(/^TCK-/);

    const updated = await runTool(staffCtx, "update_support_ticket", {
      ticketId: id,
      status: "in_progress",
      note: "Reached out to the carrier for a replacement.",
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      const t = (updated.data as any).ticket;
      expect(t.status).toBe("in_progress");
      expect(t.internalNotes).toHaveLength(1);
      expect(t.internalNotes[0].authorRole).toBe("support_agent");
      expect(t.internalNotes[0].content).toBe("Reached out to the carrier for a replacement.");
    }
    // Persists to storage.
    const stored = await env.repo.getTicket(id);
    expect(JSON.parse(stored!.internalNotes!)).toHaveLength(1);
  });

  it("note is agent-only: a second note appends without replacing the first", async () => {
    const env = makeEnv();
    const staffCtx = { repo: env.repo, auditor: env.auditor, principal: principal("ADMIN-1", "admin"), conversationId: null };
    const created = await runTool(ctx(env), "create_support_ticket", {
      subject: "Login issue",
      description: "Cannot sign in to my account.",
      priority: "medium",
    });
    const id = (created.ok ? (created.data as any).ticket.id : "") as string;
    await runTool(staffCtx, "update_support_ticket", { ticketId: id, note: "First note." });
    await runTool(staffCtx, "update_support_ticket", { ticketId: id, note: "Second note." });
    const updated = await runTool(staffCtx, "update_support_ticket", { ticketId: id, status: "resolved" });
    const t = (updated.ok ? (updated.data as any).ticket : null) as any;
    expect(t.internalNotes.map((n: any) => n.content)).toEqual(["First note.", "Second note."]);
  });
});
