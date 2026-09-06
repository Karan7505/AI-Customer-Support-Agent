import type { Principal, RiskLevel } from "./types";
import type { Role } from "@/db/schema";

/**
 * Deterministic risk + permission engine. NONE of this is delegated to the LLM.
 * These pure functions are the single source of truth for "can I" and "how
 * risky is it", and are exercised directly by unit tests.
 */

/** Role-level access rules (resource ownership is enforced inside the tool). */
export const STAFF_ROLES: Role[] = ["support_agent", "admin"];

export function isStaff(role: Role | string): boolean {
  return (STAFF_ROLES as string[]).includes(role);
}

/** Tool categories, used by both risk and permission rules. */
const READ_TOOLS = new Set([
  "get_order",
  "list_customer_orders",
  "get_tracking_status",
  "lookup_policy",
]);
const MEDIUM_TOOLS = new Set(["create_support_ticket", "update_support_ticket"]);
const HIGH_TOOLS = new Set(["request_refund", "process_refund"]);
// Broad search tools: staff-only (customers keep their own-data tools above).
const STAFF_READ_TOOLS = new Set(["search_customers", "list_orders", "list_tickets"]);

/**
 * Classify the risk of a tool call. Fails closed: unknown tools are HIGH.
 * @param toolName  the tool being invoked
 * @param args      validated arguments
 * @param user      the authenticated principal
 */
export function getRiskLevel(
  toolName: string,
  _args: Record<string, unknown>,
  _user: Principal,
): RiskLevel {
  if (READ_TOOLS.has(toolName) || STAFF_READ_TOOLS.has(toolName)) return "low";
  if (MEDIUM_TOOLS.has(toolName)) return "medium";
  // Financial / destructive / unknown => high (fail-closed).
  return "high";
}

/** Does this tool require human approval before it may execute? */
export function requiresApproval(
  toolName: string,
  args: Record<string, unknown>,
  user: Principal,
): boolean {
  const level = getRiskLevel(toolName, args, user);
  if (toolName === "request_refund") return true;
  if (level === "high") return true;
  return false;
}

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Role-level capability check. A tool being "allowed" here is necessary but not
 * sufficient: the tool handler still enforces resource ownership (customers
 * can only act on their own records; staff tools can act on any customer).
 */
export function authorize(
  toolName: string,
  user: Principal,
): PermissionResult {
  const role: Role = user.role;

  // process_refund is an INTERNAL tool: it is never exposed to the LLM and
  // must never be authorized through the normal tool path.
  if (toolName === "process_refund") {
    return { allowed: false, reason: "process_refund is an internal, approval-gated tool." };
  }

  // Broad search tools are staff-only. Customers use their own-data tools.
  if (STAFF_READ_TOOLS.has(toolName)) {
    if (isStaff(role)) return { allowed: true };
    return { allowed: false, reason: "That tool is limited to support staff." };
  }

  if (READ_TOOLS.has(toolName) || toolName === "lookup_policy") {
    return { allowed: true };
  }
  if (toolName === "create_support_ticket" || toolName === "update_support_ticket") {
    return { allowed: true };
  }
  if (toolName === "request_refund") {
    // Customers refund their own orders; staff can initiate on a customer's
    // behalf (still gated by approval + ownership checks in the tool).
    if (role === "customer" || isStaff(role)) return { allowed: true };
    return { allowed: false, reason: "Role not allowed to request refunds." };
  }

  // Unknown / unlisted tool => deny (fail-closed).
  return { allowed: false, reason: `Tool '${toolName}' is not authorized for role '${role}'.` };
}

/**
 * Which tools can the LLM even propose for a given role? Sensitive / internal
 * tools are stripped from the function-calling schema so a prompt cannot
 * "discover" them, and the loop re-checks authorization regardless.
 */
export function visibleToolsFor(role: Role): string[] {
  const base = [
    "get_order",
    "list_customer_orders",
    "get_tracking_status",
    "create_support_ticket",
    "lookup_policy",
    "request_refund",
  ];
  if (isStaff(role)) {
    base.push("search_customers", "list_orders", "list_tickets", "update_support_ticket");
  }
  return base;
}

export { READ_TOOLS, MEDIUM_TOOLS, HIGH_TOOLS, STAFF_READ_TOOLS };
