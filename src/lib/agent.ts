import type { Repo } from "@/db/repos";
import { buildSystemPrompt, type LlmClient, type LlmMessage } from "./llm";
import { agentMaxIterations } from "./env";
import { authorize, getRiskLevel, visibleToolsFor } from "./policy";
import { runTool, toolSchemaFor } from "./tools";
import { createAuditor, type Auditor } from "./audit";
import { nowMs } from "./util";
import type { AgentCard, AgentEvent, Principal, ToolResult } from "./types";

export interface AgentTurnInput {
  principal: Principal;
  userText: string;
  conversationId?: string | null;
}

export interface AgentTurnResult {
  assistantText: string;
  cards: AgentCard[];
  structured?: Record<string, unknown>;
  events: AgentEvent[];
}

/**
 * The controlled agent loop.
 *
 * For each iteration the LLM proposes either a tool call or a final message.
 * EVERY tool call is, in application code:
 *   1. known + not internal          (tool routing)
 *   2. input-validated (Zod)         (done inside runTool)
 *   3. role-authorized               (permission)
 *   4. risk-classified               (risk engine)
 *   5. executed (or gated for approval)
 * Tool outputs are structured data, appended as tool messages, and re-offered
 * to the LLM. A hard iteration cap prevents infinite loops.
 */
export function createAgent(repo: Repo, llm: LlmClient) {
  const auditor: Auditor = createAuditor(repo);

  async function runTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    const { principal, userText } = input;
    const events: AgentEvent[] = [];
    const maxIter = agentMaxIterations();

    const conversation = repo.getOrCreateConversation(principal.id);
    const conversationId = conversation.id;

    // Persist the user message and load history for the LLM context.
    repo.addMessage({
      conversationId,
      role: "user",
      content: userText,
      createdAt: nowMs(),
    });
    const history = repo.listMessages(conversationId);
    const llmMessages: LlmMessage[] = [
      { role: "system", content: buildSystemPrompt(principal) },
      ...history.slice(-20).map((m) => ({
        role: (m.role === "tool" ? "tool" : m.role === "assistant" ? "assistant" : "user") as
          | "system"
          | "user"
          | "assistant"
          | "tool",
        content: m.content,
        ...(m.role === "tool" && m.meta ? { name: (JSON.parse(m.meta).toolName as string) } : {}),
      })),
    ];

    const toolNames = visibleToolsFor(principal.role);
    const tools = toolSchemaFor(toolNames);
    const calledOnce = new Set<string>();

    let finalText = "";
    let finalCards: AgentCard[] = [];
    let structured: Record<string, unknown> | undefined;
    let finalized = false;

    for (let i = 0; i < maxIter; i++) {
      const plan = await llm.plan(llmMessages, tools);

      if (plan.kind === "final") {
        finalText = plan.text;
        finalCards = plan.cards ?? [];
        structured = plan.cards?.[0] ? cardToStructured(plan.cards[0]) : undefined;
        events.push({ type: "assistant", text: finalText, cards: finalCards });
        finalized = true;
        break;
      }

      // --- tool call path -------------------------------------------------
      const toolName = plan.tool;
      const args = plan.args ?? {};

      events.push({ type: "tool_call", toolName, args });

      // 1. Known + not internal.
      if (!toolNames.includes(toolName)) {
        const err = { ok: false, error: { code: "TOOL_ERROR", message: `Unknown tool: ${toolName}` } } as ToolResult;
        events.push({ type: "tool_result", toolName, result: err });
        appendToolMsg(llmMessages, toolName, JSON.stringify(err), i);
        auditor.log({ actor: principal, conversationId }, "tool.rejected_unknown", { toolName, arguments: args });
        continue;
      }

      // 2. Loop guard: don't let the model spin the same call twice.
      const dedupeKey = `${toolName}:${JSON.stringify(sortedArgs(args))}`;
      if (calledOnce.has(dedupeKey)) {
        const err = {
          ok: false,
          error: { code: "TOOL_ERROR", message: "This exact tool call was already made in this turn; proceed to your final answer." },
        } as ToolResult;
        events.push({ type: "tool_result", toolName, result: err });
        appendToolMsg(llmMessages, toolName, JSON.stringify(err), i);
        continue;
      }
      calledOnce.add(dedupeKey);

      // 3. Authorization (role). 4. Risk.
      const perm = authorize(toolName, principal);
      let result: ToolResult;
      if (!perm.allowed) {
        result = { ok: false, error: { code: "FORBIDDEN", message: perm.reason ?? "Not authorized." } };
        auditor.log(
          { actor: principal, conversationId },
          "tool.authorized_no",
          { toolName, arguments: args, result: { reason: perm.reason } },
        );
      } else {
        const risk = getRiskLevel(toolName, args, principal);
        auditor.log(
          { actor: principal, conversationId },
          "tool.authorized_yes",
          { toolName, arguments: args, result: { risk } },
        );
        try {
          result = await runTool(
            { repo, auditor, principal, conversationId },
            toolName,
            args,
          );
        } catch (e) {
          result = toToolError(e);
        }
      }

      // Emit domain events so the UI can render cards/statuses accurately.
      emitDomainEvents(events, toolName, result, principal, conversationId);

      events.push({ type: "tool_result", toolName, result });
      appendToolMsg(llmMessages, toolName, JSON.stringify(result), i);

      // If a refund was requested (approval created), the flow is done: we must
      // not let the model keep calling tools. Force a final next iteration by
      // recording the outcome; the planner will summarize.
      if (toolName === "request_refund" && result.ok) {
        // The planner will read the pending_approval result and finalize next.
        continue;
      }
    }

    if (!finalized) {
      // Hit the iteration cap without a final answer.
      finalText = "I hit my limit of steps on that. Could you try rephrasing your request?";
      events.push({ type: "error", code: "MAX_ITERATIONS", message: finalText });
    }

    // Persist the assistant message.
    const meta = { cards: finalCards, structured, events: events.map((e) => summarizeEvent(e)) };
    repo.addMessage({
      conversationId,
      role: "assistant",
      content: finalText,
      meta,
      createdAt: nowMs(),
    });
    auditor.log({ actor: principal, conversationId }, "agent.turn_complete", {
      result: { iterationsUsed: calledOnce.size + 1, finalText: finalText.slice(0, 200) },
    });

    return { assistantText: finalText, cards: finalCards, structured, events };
  }

  return { runTurn };
}

function appendToolMsg(messages: LlmMessage[], name: string, content: string, _i: number) {
  messages.push({ role: "tool", content, name });
}

function sortedArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b)));
}

function toToolError(e: unknown): ToolResult {
  // AppError carries a stable code + message; anything else is a generic tool error.
  if (e && typeof e === "object" && "code" in e && "message" in e) {
    const err = e as { code: string; message: string; details?: unknown };
    return { ok: false, error: { code: err.code, message: err.message, details: err.details } };
  }
  return {
    ok: false,
    error: { code: "TOOL_ERROR", message: e instanceof Error ? e.message : String(e) },
  };
}

function cardToStructured(card: AgentCard): Record<string, unknown> {
  if (card.kind === "refund") {
    return {
      status: card.status,
      action: "refund",
      orderId: card.orderId,
      amount: card.amount,
      currency: card.currency,
      approvalId: card.approvalId,
    };
  }
  if (card.kind === "approval") {
    return {
      status: "pending_approval",
      action: "approval",
      orderId: card.orderId,
      amount: card.amount,
      approvalId: card.approvalId,
    };
  }
  if (card.kind === "order") {
    return { status: "ok", action: "order", orderId: card.order.id, orderStatus: card.order.status };
  }
  if (card.kind === "ticket") {
    return { status: "ok", action: "ticket", ticketId: card.ticket.id };
  }
  return {};
}

function emitDomainEvents(
  events: AgentEvent[],
  toolName: string,
  result: ToolResult,
  principal: Principal,
  conversationId: string,
) {
  if (!result.ok) return;
  const data: any = result.data;
  if (toolName === "get_order") events.push({ type: "order_result", order: data.order, tracking: null });
  if (toolName === "get_tracking_status") events.push({ type: "order_result", order: data.order, tracking: data.tracking });
  if (toolName === "create_support_ticket") events.push({ type: "ticket_result", ticket: data.ticket });
  if (toolName === "request_refund" && data?.status === "pending_approval") {
    events.push({
      type: "approval_created",
      approval: {
        id: data.approvalId,
        requestedBy: principal.id,
        actorRole: principal.role,
        actionType: "refund",
        toolName: "process_refund",
        arguments: {},
        riskLevel: "high",
        status: "pending_approval",
        approvedBy: null,
        rejectionReason: null,
        orderId: data.orderId,
        amountCents: data.amount,
        idempotencyKey: null,
        createdAt: nowMs(),
        resolvedAt: null,
      },
    });
  }
}

function summarizeEvent(e: AgentEvent): Record<string, unknown> {
  switch (e.type) {
    case "tool_call":
      return { type: "tool_call", toolName: e.toolName, args: e.args };
    case "tool_result":
      return { type: "tool_result", toolName: e.toolName, ok: e.result.ok };
    case "approval_created":
      return { type: "approval_created", approvalId: e.approval.id };
    case "assistant":
      return { type: "assistant" };
    case "error":
      return { type: "error", code: e.code };
    default:
      return { type: e.type };
  }
}

export type Agent = ReturnType<typeof createAgent>;
