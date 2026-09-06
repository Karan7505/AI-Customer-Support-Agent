import { describe, it, expect } from "vitest";
import { getRiskLevel, authorize, visibleToolsFor, requiresApproval } from "@/lib/policy";
import { principal } from "../helpers";

const cust = () => principal("CUST-1", "customer");
const supp = () => principal("SUPP-1", "support_agent");
const admin = () => principal("ADMIN-1", "admin");

describe("Risk classification (deterministic)", () => {
  it("classifies reads as low risk", () => {
    expect(getRiskLevel("get_order", { orderId: "ORD-1" }, cust())).toBe("low");
    expect(getRiskLevel("get_tracking_status", { orderId: "ORD-1" }, cust())).toBe("low");
    expect(getRiskLevel("lookup_policy", { query: "returns" }, cust())).toBe("low");
  });
  it("classifies ticket creation as medium risk", () => {
    expect(getRiskLevel("create_support_ticket", { subject: "s", description: "d", priority: "low" }, cust())).toBe("medium");
  });
  it("classifies refunds as high risk", () => {
    expect(getRiskLevel("request_refund", { orderId: "ORD-1", reason: "x" }, cust())).toBe("high");
  });
  it("fails closed: unknown tools are high risk", () => {
    expect(getRiskLevel("delete_everything", {}, cust())).toBe("high");
  });
});

describe("Role authorization (deterministic)", () => {
  it("allows customers to read their own data", () => {
    expect(authorize("get_order", cust()).allowed).toBe(true);
    expect(authorize("list_customer_orders", cust()).allowed).toBe(true);
  });
  it("allows ticket creation for customers, support, and admin", () => {
    expect(authorize("create_support_ticket", cust()).allowed).toBe(true);
    expect(authorize("create_support_ticket", supp()).allowed).toBe(true);
    expect(authorize("create_support_ticket", admin()).allowed).toBe(true);
  });
  it("never authorizes the internal process_refund tool via the normal path", () => {
    expect(authorize("process_refund", admin()).allowed).toBe(false);
    expect(authorize("process_refund", cust()).allowed).toBe(false);
  });
  it("denies unknown tools", () => {
    expect(authorize("drop_database", cust()).allowed).toBe(false);
  });
});

describe("Approval requirements", () => {
  it("requires approval for refunds", () => {
    expect(requiresApproval("request_refund", { orderId: "ORD-1", reason: "x" }, cust())).toBe(true);
  });
  it("does not require approval for reads", () => {
    expect(requiresApproval("get_order", { orderId: "ORD-1" }, cust())).toBe(false);
  });
});

describe("Visible tool schema strips sensitive tools", () => {
  it("never exposes process_refund to the LLM", () => {
    expect(visibleToolsFor("admin")).not.toContain("process_refund");
    expect(visibleToolsFor("customer")).not.toContain("process_refund");
  });
  it("exposes the safe tool set", () => {
    const tools = visibleToolsFor("customer");
    expect(tools).toContain("get_order");
    expect(tools).toContain("request_refund");
  });
});
