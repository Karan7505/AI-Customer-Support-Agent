/**
 * Small, static knowledge base of general company policy.
 *
 * This is for GENERAL policy only. Anything customer-specific (order status,
 * tracking, refund balance) MUST come from tools, never from this file.
 * Answers carry source metadata so the UI can show a citation.
 */

export interface KbEntry {
  id: string;
  topic: string;
  title: string;
  body: string;
  /** Keywords the router matches on to route a question to this entry. */
  keywords: string[];
}

export const KNOWLEDGE_BASE: KbEntry[] = [
  {
    id: "returns",
    topic: "returns",
    title: "Returns policy",
    body: "You can return most unused items within 30 days of delivery for a full refund to the original payment method. Items must be in their original packaging. To start a return, open a support ticket and we will send a prepaid label.",
    keywords: ["return", "returns", "return policy", "return item", "send back"],
  },
  {
    id: "refund-timeline",
    topic: "refund-timeline",
    title: "Refund timeline",
    body: "Once a refund is approved and processed, it typically appears on your original payment method within 5-10 business days, depending on your bank. Refunds require a manual approval step for your protection, so they are not instant.",
    keywords: ["refund", "how long", "timeline", "when will i be refunded", "refund status", "money back"],
  },
  {
    id: "shipping",
    topic: "shipping",
    title: "Shipping",
    body: "Orders are usually processed within 1-2 business days. Standard shipping takes 3-7 business days; express options may be available at checkout. You can view live tracking any time by asking about your order in this chat.",
    keywords: ["shipping", "ship", "delivery time", "how fast", "track", "tracking", "where is my order"],
  },
  {
    id: "damaged",
    topic: "damaged",
    title: "Damaged or wrong items",
    body: "If an item arrives damaged or is the wrong item, open a support ticket and we will help with a replacement or refund. You do not need to return the item for damage. Photos help us process it faster.",
    keywords: ["damaged", "broken", "cracked", "wrong item", "defective", "arrived damaged", "not right"],
  },
  {
    id: "exchanges",
    topic: "exchanges",
    title: "Exchanges",
    body: "We support exchanges for the wrong size or color within 30 days of delivery. Start by opening a support ticket and tell us what you would like instead; we will arrange the swap.",
    keywords: ["exchange", "swap", "different size", "wrong size", "change to"],
  },
  {
    id: "cancellation",
    topic: "cancellation",
    title: "Order cancellation",
    body: "You can cancel an order for free while it is still 'pending' or 'processing' (before it ships). Once shipped, cancellation is no longer possible but you can return it on delivery within the return window.",
    keywords: ["cancel", "cancellation", "cancel my order", "stop my order"],
  },
  {
    id: "hours",
    topic: "hours",
    title: "Support hours",
    body: "Our support chat is available 24/7. A human agent reviews time-sensitive requests such as refunds during business hours (Mon-Fri, 9am-6pm local). You can always reach us here.",
    keywords: ["hours", "when are you open", "support hours", "contact", "live agent", "phone"],
  },
];

export interface KbAnswer {
  entry: KbEntry;
  topic: string;
  text: string;
  citation: { source: string; id: string; title: string };
}

/**
 * Deterministic FAQ matching. Returns the best-matching policy entry or null.
 * General policy only - never returns customer-specific data.
 */
export function lookupPolicy(query: string): KbAnswer | null {
  const q = query.toLowerCase();
  let best: KbEntry | null = null;
  let bestScore = 0;
  for (const entry of KNOWLEDGE_BASE) {
    let score = 0;
    for (const kw of entry.keywords) {
      if (q.includes(kw)) score += kw.includes(" ") ? 2 : 1;
    }
    // Topic word itself
    if (q.includes(entry.topic.toLowerCase())) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  if (!best || bestScore === 0) return null;
  return {
    entry: best,
    topic: best.topic,
    text: best.body,
    citation: { source: "company-policy-kb", id: best.id, title: best.title },
  };
}
